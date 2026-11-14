// methods/export/jobs.js
// The ExportJob queue for "Download my data": requesting, polling, building
// (in the backup worker), download links, and cleanup.

import crypto from 'crypto'
import { ExportJob, User } from '#schema'
import { buildExport } from './buildExport.js'
import { getStorageAdapter } from '#methods/files/index.js'
import { getSetting } from '#methods/settings/cache.js'
import { sendEmail } from '#methods/email/index.js'
import { exportReadyEmail } from '#methods/email/templates.js'
import logger from '#methods/utils/logger.js'

export const KEEP_DAYS = 7                    // a finished export can be downloaded for a week
const FAILED_TTL = 2 * 24 * 60 * 60 * 1000
const MIN_GAP_MS = 60 * 60 * 1000             // one request an hour per person
const LEASE_MS = 10 * 60 * 1000
const HEARTBEAT_MS = 2 * 60 * 1000
const LINK_TTL_S = 60 * 60                    // download links last an hour

// ── Download links ───────────────────────────────────────────────────────────
// The settings page asks for the job's status with the person's session and
// gets back a short-lived signed link. A plain link (not a fetch with an
// Authorization header) is what lets a browser or phone download a large zip
// straight to disk. Nothing long-lived is ever emailed.

function secret() {
  return process.env.JWT_SECRET || process.env.FILE_URL_SECRET || ''
}
function sign(jobId, exp) {
  return crypto.createHmac('sha256', secret()).update(`export:${jobId}:${exp}`).digest('base64url')
}
export function downloadUrl(job) {
  const domain = getSetting('domain')
  const exp = Math.floor(Date.now() / 1000) + LINK_TTL_S
  return `https://${domain}/auth/export/download?job=${job._id}&exp=${exp}&sig=${sign(String(job._id), exp)}`
}
export function verifyDownload(jobId, exp, sig) {
  if (!jobId || !exp || !sig || !secret()) return false
  const expNum = Number(exp)
  if (!Number.isFinite(expNum) || expNum * 1000 < Date.now()) return false
  const a = Buffer.from(String(sig))
  const b = Buffer.from(sign(String(jobId), String(exp)))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// What the settings page shows.
export function describe(job) {
  if (!job) return null
  const out = {
    status: job.status,
    stage: job.stage || '',
    requestedAt: job.createdAt,
  }
  if (job.status === 'done') {
    out.readyAt = job.readyAt
    out.expiresAt = job.expiresAt
    out.sizeBytes = job.sizeBytes
    out.fileName = job.archiveName
    out.downloadUrl = downloadUrl(job)
  }
  if (job.status === 'failed') out.error = job.error
  return out
}

export async function latestExport(actorId) {
  return ExportJob.findOne({ actorId, expiresAt: { $not: { $lt: new Date() } } })
    .sort({ createdAt: -1 })
    .lean()
}

// Returns { job } or { error, status }.
export async function requestExport(actorId) {
  const last = await ExportJob.findOne({ actorId }).sort({ createdAt: -1 }).lean()
  if (last && (last.status === 'pending' || last.status === 'running')) {
    return { job: last }
  }
  if (last && Date.now() - new Date(last.createdAt).getTime() < MIN_GAP_MS) {
    const mins = Math.ceil((MIN_GAP_MS - (Date.now() - new Date(last.createdAt).getTime())) / 60000)
    return { status: 429, error: `You can ask for a new copy in ${mins} minute${mins === 1 ? '' : 's'}.` }
  }
  const job = await ExportJob.create({ actorId, stage: 'Waiting to start' })
  return { job: job.toObject() }
}

async function deleteArchive(job) {
  if (!job?.archiveKey) return
  try {
    await (await getStorageAdapter()).delete(job.archiveKey)
  } catch (err) {
    logger.warn('[export] Could not delete archive', { key: job.archiveKey, error: err.message })
  }
}

// Every export for one account -- used when the account is deleted.
export async function deleteExportsFor(actorId) {
  const jobs = await ExportJob.find({ actorId }).lean()
  for (const j of jobs) await deleteArchive(j)
  await ExportJob.deleteMany({ actorId })
}

// Expired and failed exports: delete the zip, then the record.
export async function pruneExports() {
  const old = await ExportJob.find({ expiresAt: { $lt: new Date() } }).lean()
  for (const j of old) {
    await deleteArchive(j)
    await ExportJob.deleteOne({ _id: j._id })
  }
  return old.length
}

async function recoverExpiredLeases() {
  const now = new Date()
  await ExportJob.updateMany(
    {
      status: 'running',
      $or: [
        { leaseUntil: { $lt: now } },
        { leaseUntil: null, updatedAt: { $lt: new Date(now.getTime() - LEASE_MS) } },
      ],
    },
    { $set: { status: 'pending', stage: 'Restarting' }, $unset: { leaseUntil: 1 } }
  )
}

// Claim and build one pending export. Called from the backup worker's loop.
export async function pollExportOnce() {
  await recoverExpiredLeases()
  const claimed = await ExportJob.findOneAndUpdate(
    { status: 'pending' },
    { $set: { status: 'running', stage: 'Starting', leaseUntil: new Date(Date.now() + LEASE_MS) } },
    { new: true, sort: { createdAt: 1 } }
  )
  if (!claimed) return false

  const heartbeat = setInterval(() => {
    ExportJob.updateOne(
      { _id: claimed._id, status: 'running' },
      { $set: { leaseUntil: new Date(Date.now() + LEASE_MS) } }
    ).catch(() => {})
  }, HEARTBEAT_MS)
  const progress = (stage) => ExportJob.updateOne({ _id: claimed._id }, { $set: { stage } })

  try {
    logger.info('[export] Building', { jobId: claimed._id, actorId: claimed.actorId })
    const result = await buildExport(claimed, progress)
    const readyAt = new Date()
    const expiresAt = new Date(readyAt.getTime() + KEEP_DAYS * 24 * 60 * 60 * 1000)
    await ExportJob.updateOne(
      { _id: claimed._id },
      { $set: { status: 'done', stage: 'Ready', readyAt, expiresAt, ...result }, $unset: { leaseUntil: 1 } }
    )

    // Only one copy at a time: drop any older finished ones.
    const older = await ExportJob.find({ actorId: claimed.actorId, _id: { $ne: claimed._id } }).lean()
    for (const j of older) {
      if (j.status === 'pending' || j.status === 'running') continue
      await deleteArchive(j)
      await ExportJob.deleteOne({ _id: j._id })
    }

    const user = await User.findOne({ id: claimed.actorId }).select('email').lean()
    if (user?.email) {
      const domain = getSetting('domain')
      const { subject, html } = exportReadyEmail({ pageUrl: `https://${domain}/profile`, days: KEEP_DAYS })
      await sendEmail({ to: user.email, subject, html }).catch((err) =>
        logger.warn('[export] Ready email failed', { error: err.message })
      )
    }
  } catch (err) {
    logger.error('[export] Failed', { jobId: claimed._id, error: err.message })
    await ExportJob.updateOne(
      { _id: claimed._id },
      {
        $set: {
          status: 'failed',
          stage: 'Failed',
          error: err.message,
          expiresAt: new Date(Date.now() + FAILED_TTL),
        },
        $unset: { leaseUntil: 1 },
      }
    )
  } finally {
    clearInterval(heartbeat)
  }
  return true
}
