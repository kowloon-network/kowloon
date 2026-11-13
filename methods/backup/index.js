// methods/backup/index.js
// Core backup and restore logic. Called by workers/backup.js.
//
// Both functions receive a BackupJob document and a progress updater:
//   updateProgress(stage, pct) — async, patches the job in Mongo
//
// Design constraints (alpha):
//   - Small servers only. Everything fits in temp dirs comfortably.
//   - mongodump/mongorestore + tar must be on PATH (added to Docker image).
//   - Files live in a single S3/MinIO bucket. No cross-bucket ops.
//   - Archive uploaded to the same bucket under _backups/ prefix.
//   - Restore reads the archive from _backups/ (or a temp-upload key).
//   - S3Adapter internals (client, bucket) used directly for fixed-key uploads.

import mongoose from 'mongoose'
import { spawn } from 'child_process'
import { createWriteStream, createReadStream } from 'fs'
import { mkdir, rm, readdir, stat, readFile, writeFile } from 'fs/promises'
import { join, relative } from 'path'
import { tmpdir } from 'os'
import { pipeline as pipelineCallback } from 'stream'
import { promisify } from 'util'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { getStorageAdapter } from '#methods/files/index.js'
import { sendEmail } from '#methods/email/index.js'
import { backupReadyEmail } from '#methods/email/templates.js'
import { adminEmails, formatBytes } from './manage.js'
import { getSetting } from '#methods/settings/cache.js'
import logger from '#methods/utils/logger.js'

const pipeline = promisify(pipelineCallback)

// ── Helpers ───────────────────────────────────────────────────────────────────

function spawnPipe(cmd, args, { stdin, stdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const stderr = []
    child.stderr.on('data', (d) => stderr.push(d))

    if (stdin) stdin.pipe(child.stdin)
    if (stdout) child.stdout.pipe(stdout)

    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited ${code}: ${Buffer.concat(stderr).toString().slice(0, 500)}`))
    })
    child.on('error', reject)
  })
}

async function downloadObjectToFile(storage, key, destPath) {
  const stream = await storage.getStream(key)
  await pipeline(stream, createWriteStream(destPath))
}

async function walkDir(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) files.push(...(await walkDir(full)))
    else files.push(full)
  }
  return files
}

// Upload a local file to S3 at an exact key (bypass the random-key
// generator). Streamed, not read into memory: a full backup can be larger
// than the container's RAM.
async function putFileAtKey(storage, key, filePath, contentType = 'application/octet-stream') {
  const { size } = await stat(filePath)
  // Multipart upload: a single PutObject is capped at 5 GB.
  await new Upload({
    client: storage.client,
    params: { Bucket: storage.bucket, Key: key, Body: createReadStream(filePath), ContentType: contentType },
  }).done()
  return size
}

async function putBufAtKey(storage, key, buf, contentType = 'application/octet-stream') {
  await storage.client.send(new PutObjectCommand({
    Bucket: storage.bucket,
    Key: key,
    Body: buf,
    ContentType: contentType,
  }))
}

// ── runBackup ─────────────────────────────────────────────────────────────────

export async function runBackup(job, updateProgress) {
  const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/kowloon'
  const domain = getSetting('domain') || 'localhost'
  const adminEmail = getSetting('adminEmail')

  // "database": just the database (small). "full": the database and every
  // uploaded file.
  const databaseOnly = job.kind === 'database'

  const workDir = join(tmpdir(), `kowloon-backup-${job._id}`)
  await mkdir(workDir, { recursive: true })

  try {
    // 1. mongodump ────────────────────────────────────────────────────────────
    await updateProgress('Dumping database', 10)
    logger.info('[backup] Running mongodump')

    const dbArchivePath = join(workDir, 'db.archive')

    await new Promise((resolve, reject) => {
      const dump = spawn('mongodump', [
        `--uri=${mongoUri}`,
        '--archive',
        '--gzip',
        '--quiet',
      ], { stdio: ['ignore', 'pipe', 'pipe'] })

      const out = createWriteStream(dbArchivePath)
      const stderr = []
      dump.stderr.on('data', (d) => stderr.push(d))
      dump.stdout.pipe(out)

      // Wait for both the process to exit AND the write stream to finish
      // flushing — 'close' on the child can fire before 'finish' on the
      // writable, leaving db.archive empty if we resolve on 'close' alone.
      let exitCode = null
      let streamDone = false
      const maybeResolve = () => {
        if (exitCode === null || !streamDone) return
        if (exitCode === 0) resolve()
        else reject(new Error(`mongodump exited ${exitCode}: ${Buffer.concat(stderr).toString().slice(0, 500)}`))
      }
      dump.on('close', (code) => { exitCode = code; maybeResolve() })
      dump.on('error', reject)
      out.on('finish', () => { streamDone = true; maybeResolve() })
      out.on('error', reject)
    })

    logger.info('[backup] Database dump complete')

    // 2. Download files from S3 (full backups only) ──────────────────────────
    const storage = await getStorageAdapter()
    const filesDir = join(workDir, 'files')
    await mkdir(filesDir, { recursive: true })

    let fileKeys = []
    if (!databaseOnly) {
    await updateProgress('Downloading files', 30)
    const allKeys = await storage.listAllObjects()
    fileKeys = allKeys.filter((k) => !k.startsWith('_backups/') && !k.startsWith('_restore-tmp/'))

    logger.info(`[backup] Downloading ${fileKeys.length} files`)

    for (let i = 0; i < fileKeys.length; i++) {
      const key = fileKeys[i]
      const destPath = join(filesDir, key)
      await mkdir(join(destPath, '..'), { recursive: true })
      await downloadObjectToFile(storage, key, destPath)

      if (i % 10 === 0) {
        const pct = 30 + Math.round((i / Math.max(fileKeys.length, 1)) * 40)
        await updateProgress('Downloading files', pct)
      }
    }
    }

    // 3. Write manifest ────────────────────────────────────────────────────────
    await updateProgress('Packaging archive', 72)

    const manifest = {
      version: 2,
      createdAt: new Date().toISOString(),
      domain,
      database: mongoUri.split('/').pop()?.split('?')[0] || 'kowloon',
      contents: databaseOnly ? 'database' : 'full',
      fileCount: fileKeys.length,
    }
    await writeFile(join(workDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

    // 4. Package as tar.gz via system tar ─────────────────────────────────────
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const archiveName = `kowloon-${databaseOnly ? 'database' : 'full'}-backup-${ts}.tar.gz`
    const archivePath = join(tmpdir(), archiveName)

    await new Promise((resolve, reject) => {
      const proc = spawn('tar', ['-czf', archivePath, '-C', workDir, 'manifest.json', 'db.archive', 'files'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      const stderr = []
      proc.stderr.on('data', (d) => stderr.push(d))
      proc.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`tar exited ${code}: ${Buffer.concat(stderr).toString()}`))
      })
      proc.on('error', reject)
    })

    logger.info(`[backup] Archive packaged: ${archiveName}`)

    // 5. Upload archive to S3 at fixed key ────────────────────────────────────
    await updateProgress('Uploading archive', 82)

    const archiveKey = `_backups/${archiveName}`
    const sizeBytes = await putFileAtKey(storage, archiveKey, archivePath, 'application/gzip')
    await rm(archivePath, { force: true })

    logger.info(`[backup] Archive uploaded to S3: ${archiveKey}`)

    // 6. Email the admin who asked for it (manual backups only -- a nightly
    // email would just be noise; scheduled ones email only on failure).
    if (job.trigger !== 'scheduled') {
      await updateProgress('Sending notification', 95)
      const to = (await adminEmails({ only: job.requestedBy }))[0] || adminEmail
      if (to) {
        try {
          const { subject, html } = backupReadyEmail({
            pageUrl: `https://${domain}/admin/settings#maintenance`,
            kind: databaseOnly ? 'database' : 'full',
            size: formatBytes(sizeBytes),
          })
          await sendEmail({ to, subject, html })
          logger.info(`[backup] Notification email sent to ${to}`)
        } catch (err) {
          logger.warn('[backup] Failed to send notification email', { error: err.message })
        }
      }
    }

    await updateProgress('Complete', 100)
    return { archiveKey, archiveName, sizeBytes }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

// ── runRestore ────────────────────────────────────────────────────────────────

export async function runRestore(job, updateProgress) {
  const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/kowloon'
  const storage = await getStorageAdapter()

  const workDir = join(tmpdir(), `kowloon-restore-${job._id}`)
  await mkdir(workDir, { recursive: true })

  try {
    // 1. Download archive from S3 ──────────────────────────────────────────────
    await updateProgress('Downloading archive', 10)
    logger.info(`[restore] Downloading archive: ${job.archiveKey}`)

    const archivePath = join(workDir, 'archive.tar.gz')
    await downloadObjectToFile(storage, job.archiveKey, archivePath)

    // 2. Extract archive ───────────────────────────────────────────────────────
    await updateProgress('Extracting archive', 20)

    const extractDir = join(workDir, 'extracted')
    await mkdir(extractDir, { recursive: true })

    await new Promise((resolve, reject) => {
      const proc = spawn('tar', ['-xzf', archivePath, '-C', extractDir], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      const stderr = []
      proc.stderr.on('data', (d) => stderr.push(d))
      proc.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`tar -xzf exited ${code}: ${Buffer.concat(stderr).toString()}`))
      })
      proc.on('error', reject)
    })

    const manifestPath = join(extractDir, 'manifest.json')
    const dbArchivePath = join(extractDir, 'db.archive')
    const filesDir = join(extractDir, 'files')

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    logger.info('[restore] Archive manifest', manifest)

    // 3. Restore MongoDB ───────────────────────────────────────────────────────
    await updateProgress('Restoring database', 35)
    logger.info('[restore] Running mongorestore')

    await new Promise((resolve, reject) => {
      const restore = spawn('mongorestore', [
        `--uri=${mongoUri}`,
        '--archive',
        '--gzip',
        '--drop',
        '--quiet',
      ], { stdio: ['pipe', 'ignore', 'pipe'] })

      const dbStream = createReadStream(dbArchivePath)
      const stderr = []
      restore.stderr.on('data', (d) => stderr.push(d))
      dbStream.pipe(restore.stdin)

      restore.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`mongorestore exited ${code}: ${Buffer.concat(stderr).toString().slice(0, 500)}`))
      })
      restore.on('error', reject)
    })

    logger.info('[restore] Database restored')

    // 4. Restore files ─────────────────────────────────────────────────────────
    await updateProgress('Restoring files', 60)

    let fileList = []
    try {
      fileList = await walkDir(filesDir)
    } catch { /* files dir may not exist in a DB-only archive */ }

    logger.info(`[restore] Uploading ${fileList.length} files to S3`)

    for (let i = 0; i < fileList.length; i++) {
      const absPath = fileList[i]
      const relKey = relative(filesDir, absPath)
      const buf = await readFile(absPath)

      await putBufAtKey(storage, relKey, buf)

      if (i % 10 === 0) {
        const pct = 60 + Math.round((i / Math.max(fileList.length, 1)) * 30)
        await updateProgress('Restoring files', pct)
      }
    }

    logger.info('[restore] Files restored')

    // 5. Ensure the user who triggered the restore still has admin access ──────
    // mongorestore --drop replaces the settings and circles collections, so the
    // requesting user may no longer be in the restored admin circle.
    if (job.requestedBy && job.requestedBy !== 'unknown') {
      try {
        const db = mongoose.connection.db
        const adminCircleSetting = await db.collection('settings').findOne({ name: 'adminCircle' })
        const adminCircleId = adminCircleSetting?.value
        if (adminCircleId) {
          const circle = await db.collection('circles').findOne({ id: adminCircleId })
          const alreadyMember = circle?.members?.some((m) => m.id === job.requestedBy)
          if (!alreadyMember) {
            const user = await db.collection('users').findOne({ id: job.requestedBy })
            if (user) {
              await db.collection('circles').updateOne(
                { id: adminCircleId },
                { $push: { members: { id: user.id, name: user.profile?.name || user.username } } }
              )
              logger.info(`[restore] Re-added ${job.requestedBy} to admin circle`)
            }
          }
        }
      } catch (err) {
        logger.warn('[restore] Could not verify admin circle membership', { error: err.message })
      }
    }

    // 6. Delete temp upload key if this was an admin-uploaded archive ──────────
    if (job.archiveKey.startsWith('_restore-tmp/')) {
      try { await storage.delete(job.archiveKey) } catch { /* best effort */ }
    }

    await updateProgress('Complete', 100)
    return { restoredFiles: fileList.length }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}
