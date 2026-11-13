// methods/backup/manage.js -- automatic backups, keeping the list tidy, and
// what backups cost in disk space.
//
// Decided with Josh 2026-11-13: backups are an ADMIN setting, off by
// default, because they're the admin's (or the host's) call and they eat
// disk. An admin can schedule database-only backups (small) and full ones
// (database + every uploaded file) separately -- e.g. the database nightly
// and everything weekly -- and say how many of each to keep. Older
// scheduled backups are deleted after each new one succeeds; manual ones
// are kept until an admin deletes them.
//
// The `autoBackup` setting:
//   { database: "off"|"daily"|"weekly", full: "off"|"daily"|"weekly",
//     keep: 1..60, hour: 0..23 (UTC) }

import { statfs } from 'fs/promises'
import { ListObjectsV2Command } from '@aws-sdk/client-s3'
import mongoose from 'mongoose'
import { BackupJob, Settings, Circle, User } from '#schema'
import { getStorageAdapter } from '#methods/files/index.js'
import { sendEmail } from '#methods/email/index.js'
import { backupFailedEmail } from '#methods/email/templates.js'
import logger from '#methods/utils/logger.js'

export const SCHEDULE_DEFAULT = { database: 'off', full: 'off', keep: 7, hour: 3 }
const FREQUENCIES = ['off', 'daily', 'weekly']
const DAY_MS = 24 * 60 * 60 * 1000

export function formatBytes(n) {
  if (n == null || Number.isNaN(n)) return 'unknown size'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

// ---- The schedule setting -------------------------------------------------

export function normalizeSchedule(raw = {}) {
  const v = { ...SCHEDULE_DEFAULT, ...(raw && typeof raw === 'object' ? raw : {}) }
  return {
    database: FREQUENCIES.includes(v.database) ? v.database : 'off',
    full: FREQUENCIES.includes(v.full) ? v.full : 'off',
    keep: Math.min(60, Math.max(1, parseInt(v.keep, 10) || SCHEDULE_DEFAULT.keep)),
    hour: Math.min(23, Math.max(0, parseInt(v.hour, 10) || 0)),
  }
}

// Read from the DB, not the settings cache: the worker runs in its own
// process and wouldn't see an admin's change otherwise.
export async function getSchedule() {
  const s = await Settings.findOne({ name: 'autoBackup' }).lean()
  return normalizeSchedule(s?.value)
}

export async function saveSchedule(raw) {
  const value = normalizeSchedule(raw)
  await Settings.updateOne({ name: 'autoBackup' }, { $set: { value } }, { upsert: true })
  return value
}

// ---- Who to tell ----------------------------------------------------------

// Email addresses of the server's admins (members of the admin circle), plus
// the adminEmail setting. `only` limits it to one admin.
export async function adminEmails({ only } = {}) {
  const setting = await Settings.findOne({ name: 'adminCircle' }).lean()
  const circle = setting?.value ? await Circle.findOne({ id: setting.value }).select('members.id').lean() : null
  let ids = (circle?.members || []).map((m) => m.id)
  if (only) ids = ids.filter((id) => id === only)
  const users = ids.length ? await User.find({ id: { $in: ids } }).select('email').lean() : []
  const emails = users.map((u) => u.email).filter(Boolean)
  if (!only) {
    const fallback = (await Settings.findOne({ name: 'adminEmail' }).lean())?.value
    if (fallback && typeof fallback === 'string') emails.push(fallback)
  }
  return [...new Set(emails.map((e) => e.toLowerCase()))]
}

export async function notifyBackupFailed(job, error) {
  const domain = (await Settings.findOne({ name: 'domain' }).lean())?.value || 'localhost'
  const to = await adminEmails()
  const { subject, html } = backupFailedEmail({
    pageUrl: `https://${domain}/admin/settings#maintenance`,
    kind: job.kind,
    scheduled: job.trigger === 'scheduled',
    error: String(error || 'unknown error').slice(0, 300),
  })
  for (const addr of to) {
    await sendEmail({ to: addr, subject, html }).catch((err) =>
      logger.warn('[backup] Failed to send failure email', { to: addr, error: err.message })
    )
  }
}

// ---- Storage --------------------------------------------------------------

// Every object under a prefix, with sizes.
async function listWithSizes(storage, prefix = '') {
  const out = []
  let token
  do {
    const resp = await storage.client.send(new ListObjectsV2Command({
      Bucket: storage.bucket,
      Prefix: prefix || undefined,
      ContinuationToken: token,
    }))
    for (const o of resp.Contents ?? []) out.push({ key: o.Key, size: o.Size ?? 0, modified: o.LastModified })
    token = resp.IsTruncated ? resp.NextContinuationToken : undefined
  } while (token)
  return out
}

// Archives in storage that no BackupJob points at -- left behind when job
// records used to expire after 48 hours while their archives stayed
// forever. Give each a record so admins can see and delete them.
export async function adoptOrphanArchives() {
  const storage = await getStorageAdapter()
  const objects = await listWithSizes(storage, '_backups/')
  if (!objects.length) return 0
  const known = new Set(
    (await BackupJob.find({ archiveKey: { $in: objects.map((o) => o.key) } }).select('archiveKey').lean())
      .map((j) => j.archiveKey)
  )
  const orphans = objects.filter((o) => !known.has(o.key))
  if (!orphans.length) return 0
  // Insert directly so createdAt can be the archive's own date.
  await BackupJob.collection.insertMany(orphans.map((o) => {
    const name = o.key.replace(/^_backups\//, '')
    return {
      type: 'backup',
      status: 'done',
      requestedBy: 'unknown',
      kind: /-database-backup-/.test(name) ? 'database' : 'full',
      trigger: 'manual',
      sizeBytes: o.size,
      archiveKey: o.key,
      archiveName: name,
      progress: { stage: 'Complete', pct: 100 },
      createdAt: o.modified || new Date(),
      updatedAt: new Date(),
    }
  }))
  logger.info('[backup] Adopted archives with no record', { count: orphans.length })
  return orphans.length
}

// Finished backups used to get a 48-hour expiry; keep them while their
// archive exists.
export async function keepFinishedBackups() {
  const r = await BackupJob.updateMany(
    { type: 'backup', status: 'done', archiveKey: { $exists: true, $ne: null }, expiresAt: { $ne: null } },
    { $unset: { expiresAt: 1 } }
  )
  return r.modifiedCount
}

export async function deleteBackup(job) {
  if (job.archiveKey) {
    try {
      const storage = await getStorageAdapter()
      await storage.delete(job.archiveKey)
    } catch (err) {
      logger.warn('[backup] Failed to delete archive', { key: job.archiveKey, error: err.message })
    }
  }
  await BackupJob.deleteOne({ _id: job._id })
}

// Keep the newest `keep` scheduled backups of this kind; delete the rest.
// Manual backups are never pruned.
export async function pruneScheduled(kind, keep) {
  const old = await BackupJob.find({ type: 'backup', status: 'done', trigger: 'scheduled', kind })
    .sort({ createdAt: -1 })
    .skip(keep)
    .lean()
  for (const job of old) await deleteBackup(job)
  if (old.length) logger.info('[backup] Pruned old scheduled backups', { kind, deleted: old.length })
  return old.length
}

// ---- When is the next one due? -------------------------------------------

// The most recent time-of-day slot (`hour`:00 UTC) at or before `now`.
function lastSlot(now, hour) {
  const d = new Date(now)
  d.setUTCHours(hour, 0, 0, 0)
  if (d > now) d.setTime(d.getTime() - DAY_MS)
  return d
}

// Is a scheduled backup of this kind due? Daily: none since today's slot.
// Weekly: none in the 7 days before the latest slot.
export async function isDue(kind, frequency, hour, now = new Date()) {
  if (frequency === 'off') return false
  const slot = lastSlot(now, hour)
  const since = frequency === 'weekly' ? new Date(slot.getTime() - 6 * DAY_MS - DAY_MS / 2) : slot
  const recent = await BackupJob.exists({
    type: 'backup',
    trigger: 'scheduled',
    // A full backup includes the database, so it satisfies a database slot.
    kind: kind === 'database' ? { $in: ['database', 'full'] } : kind,
    createdAt: { $gte: since },
    status: { $ne: 'failed' },
  })
  // A failed run doesn't count: retry, but at most once an hour.
  if (recent) return false
  const failedLately = await BackupJob.exists({
    type: 'backup', trigger: 'scheduled', kind, status: 'failed',
    createdAt: { $gte: new Date(now.getTime() - 60 * 60 * 1000) },
  })
  return !failedLately
}

export async function nextRun(frequency, hour, kind, now = new Date()) {
  if (frequency === 'off') return null
  const last = await BackupJob.findOne({ type: 'backup', trigger: 'scheduled', kind, status: 'done' })
    .sort({ createdAt: -1 }).select('createdAt').lean()
  let next = lastSlot(now, hour)
  if (next <= now) next = new Date(next.getTime() + DAY_MS)
  if (frequency === 'weekly' && last) {
    const earliest = new Date(new Date(last.createdAt).getTime() + 7 * DAY_MS - DAY_MS / 2)
    while (next < earliest) next = new Date(next.getTime() + DAY_MS)
  }
  return next
}

// Queue whatever is due. Full first: if both are due at once, the full
// backup already contains the database.
export async function queueDueBackups(now = new Date()) {
  const busy = await BackupJob.exists({ status: { $in: ['pending', 'running'] } })
  if (busy) return null
  const sched = await getSchedule()
  for (const kind of ['full', 'database']) {
    if (await isDue(kind, sched[kind], sched.hour, now)) {
      const job = await BackupJob.create({ type: 'backup', kind, trigger: 'scheduled', requestedBy: 'schedule', status: 'pending' })
      logger.info('[backup] Scheduled backup queued', { kind, jobId: job._id })
      return job
    }
  }
  return null
}

// ---- What it all costs ----------------------------------------------------

export async function backupSummary() {
  const storage = await getStorageAdapter()
  const sched = await getSchedule()

  const backups = await BackupJob.find({ type: 'backup', status: 'done' })
    .sort({ createdAt: -1 }).lean()
  const usedBytes = backups.reduce((n, b) => n + (b.sizeBytes || 0), 0)
  const lastSize = (kind) => backups.find((b) => b.kind === kind && b.sizeBytes)?.sizeBytes ?? null

  // Estimates for kinds never backed up yet: the database compresses to
  // roughly a quarter of its data size; files barely compress (media).
  let dbEstimate = lastSize('database')
  let fullEstimate = lastSize('full')
  if (dbEstimate == null || fullEstimate == null) {
    let dataSize = 0
    try { dataSize = (await mongoose.connection.db.stats()).dataSize || 0 } catch { /* ignore */ }
    const dbGuess = Math.round(dataSize / 4)
    if (dbEstimate == null) dbEstimate = dbGuess
    if (fullEstimate == null) {
      const files = (await listWithSizes(storage)).filter((o) => !o.key.startsWith('_backups/') && !o.key.startsWith('_restore-tmp/'))
      fullEstimate = (dbEstimate ?? dbGuess) + files.reduce((n, o) => n + o.size, 0)
    }
  }

  let disk = null
  try {
    const fs = await statfs(process.cwd())
    disk = { freeBytes: fs.bavail * fs.bsize, totalBytes: fs.blocks * fs.bsize }
  } catch { /* not available everywhere */ }

  // Space the schedule will use once it's full: keep x size, per kind.
  const steadyBytes =
    (sched.database !== 'off' ? sched.keep * (dbEstimate || 0) : 0) +
    (sched.full !== 'off' ? sched.keep * (fullEstimate || 0) : 0)

  return {
    schedule: sched,
    next: {
      database: await nextRun(sched.database, sched.hour, 'database'),
      full: await nextRun(sched.full, sched.hour, 'full'),
    },
    count: backups.length,
    usedBytes,
    estimate: { databaseBytes: dbEstimate, fullBytes: fullEstimate, scheduleBytes: steadyBytes },
    disk,
  }
}
