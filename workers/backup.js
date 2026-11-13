#!/usr/bin/env node
// workers/backup.js — async backup and restore worker
// Polls the BackupJob queue, claims jobs atomically, and runs them.

import "dotenv/config"
import mongoose from 'mongoose'
import { BackupJob, Settings } from '#schema'
import { loadSettings } from '#methods/settings/cache.js'
import { runBackup, runRestore } from '#methods/backup/index.js'
import {
  queueDueBackups, pruneScheduled, notifyBackupFailed, getSchedule,
  adoptOrphanArchives, keepFinishedBackups,
} from '#methods/backup/manage.js'
import logger from '#methods/utils/logger.js'
import redactUri from '#methods/utils/redactUri.js'

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/kowloon'
const POLL_MS   = parseInt(process.env.BACKUP_POLL_INTERVAL_MS || '10000', 10)
const JOB_TTL   = 48 * 60 * 60 * 1000  // 48 hours
// Claim lease + heartbeat: a crashed/killed worker used to leave its job
// 'running' forever. The heartbeat keeps a live job's lease fresh.
const LEASE_MS     = 10 * 60 * 1000
const HEARTBEAT_MS = 2 * 60 * 1000

async function updateProgress(jobId, stage, pct) {
  await BackupJob.findByIdAndUpdate(jobId, {
    'progress.stage': stage,
    'progress.pct': pct,
  })
}

// Recover jobs whose worker died mid-run (lease expired; jobs claimed before
// leases existed have none -- treat a missing lease as expired only after
// LEASE_MS since the last update). Backups are simply requeued. Restores are
// marked failed instead: re-running a half-applied restore automatically is
// not safe -- an admin should re-trigger it deliberately.
async function recoverExpiredLeases() {
  const now = new Date()
  const expired = {
    status: 'running',
    $or: [
      { leaseUntil: { $lt: now } },
      { leaseUntil: null, updatedAt: { $lt: new Date(now.getTime() - LEASE_MS) } },
    ],
  }
  const requeued = await BackupJob.updateMany(
    { ...expired, type: 'backup' },
    { $set: { status: 'pending', 'progress.stage': 'Requeued after worker crash', 'progress.pct': 0 }, $unset: { leaseUntil: 1 } }
  )
  const failed = await BackupJob.updateMany(
    { ...expired, type: 'restore' },
    {
      $set: {
        status: 'failed',
        error: 'Worker stopped mid-restore; restore may be partially applied. Re-run it manually.',
        'progress.stage': 'Failed',
        expiresAt: new Date(now.getTime() + JOB_TTL),
      },
      $unset: { leaseUntil: 1 },
    }
  )
  if (requeued.modifiedCount || failed.modifiedCount) {
    logger.warn('[backup-worker] Recovered expired job leases', {
      requeued: requeued.modifiedCount,
      failed: failed.modifiedCount,
    })
  }
}

async function pollOnce() {
  await recoverExpiredLeases()

  const jobs = await BackupJob.find({
    status: 'pending',
  }).limit(1).lean()

  if (jobs.length === 0) return

  const job = jobs[0]

  // Atomic claim
  const claimed = await BackupJob.findOneAndUpdate(
    { _id: job._id, status: 'pending' },
    {
      $set: {
        status: 'running',
        'progress.stage': 'Starting',
        'progress.pct': 0,
        leaseUntil: new Date(Date.now() + LEASE_MS),
      },
    },
    { new: true }
  )
  if (!claimed) return

  const heartbeat = setInterval(() => {
    BackupJob.updateOne(
      { _id: claimed._id, status: 'running' },
      { $set: { leaseUntil: new Date(Date.now() + LEASE_MS) } }
    ).catch((err) => logger.warn('[backup-worker] Lease heartbeat failed', { error: err.message }))
  }, HEARTBEAT_MS)

  const makeUpdater = (id) => async (stage, pct) => updateProgress(id, stage, pct)

  try {
    logger.info(`[backup-worker] Starting ${claimed.type} job`, { jobId: claimed._id })

    let result
    if (claimed.type === 'backup') {
      result = await runBackup(claimed, makeUpdater(claimed._id))
      // A finished backup is kept for as long as its archive exists.
      await BackupJob.findByIdAndUpdate(claimed._id, {
        $set: {
          status: 'done',
          'progress.stage': 'Complete',
          'progress.pct': 100,
          archiveKey: result.archiveKey,
          archiveName: result.archiveName,
          sizeBytes: result.sizeBytes,
        },
        $unset: { expiresAt: 1 },
      })
      // Only now that a new one exists, drop the oldest scheduled ones.
      if (claimed.trigger === 'scheduled') {
        const { keep } = await getSchedule()
        await pruneScheduled(claimed.kind || 'full', keep)
      }
    } else {
      result = await runRestore(claimed, makeUpdater(claimed._id))
      await BackupJob.findByIdAndUpdate(claimed._id, {
        status: 'done',
        'progress.stage': 'Complete',
        'progress.pct': 100,
        expiresAt: new Date(Date.now() + JOB_TTL),
      })
    }

    logger.info(`[backup-worker] ${claimed.type} job complete`, { jobId: claimed._id, result })
  } catch (err) {
    logger.error(`[backup-worker] ${claimed.type} job failed`, { jobId: claimed._id, error: err.message })
    await BackupJob.findByIdAndUpdate(claimed._id, {
      status: 'failed',
      error: err.message,
      'progress.stage': 'Failed',
      expiresAt: new Date(Date.now() + JOB_TTL),
    })
    // Nobody is watching a scheduled backup -- tell the admins.
    if (claimed.type === 'backup' && claimed.trigger === 'scheduled') {
      await notifyBackupFailed(claimed, err.message).catch(() => {})
    }
  } finally {
    clearInterval(heartbeat)
  }
}

async function main() {
  logger.info('[backup-worker] Starting', { mongoUri: redactUri(MONGO_URI), pollMs: POLL_MS })

  try {
    await mongoose.connect(MONGO_URI)
    logger.info('[backup-worker] MongoDB connected')
    await loadSettings(Settings)
    logger.info('[backup-worker] Settings loaded')
  } catch (err) {
    logger.error('[backup-worker] Startup failed', { error: err.message })
    process.exit(1)
  }

  let running = true

  const shutdown = async (signal) => {
    logger.info(`[backup-worker] ${signal} received, shutting down`)
    running = false
    await mongoose.disconnect()
    process.exit(0)
  }

  process.on('SIGINT',  () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  // Tidy the backup list: finished backups no longer expire, and archives
  // left without a record by the old 48-hour expiry get one back.
  try {
    const kept = await keepFinishedBackups()
    const adopted = await adoptOrphanArchives()
    if (kept || adopted) logger.info('[backup-worker] Backup list tidied', { kept, adopted })
  } catch (err) {
    logger.warn('[backup-worker] Could not tidy the backup list', { error: err.message })
  }

  logger.info('[backup-worker] Polling for jobs')

  let lastScheduleCheck = 0
  while (running) {
    try {
      // Automatic backups (Settings -> Maintenance): check once a minute.
      if (Date.now() - lastScheduleCheck >= 60 * 1000) {
        lastScheduleCheck = Date.now()
        await queueDueBackups()
      }
      await pollOnce()
    } catch (err) {
      logger.error('[backup-worker] Poll error', { error: err.message })
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

main().catch((err) => {
  console.error('[backup-worker] Fatal:', err)
  process.exit(1)
})
