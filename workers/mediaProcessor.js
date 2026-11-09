#!/usr/bin/env node
// workers/mediaProcessor.js — async media processing worker
// Polls the MediaJob queue, runs the configured processor adapter, and marks
// files ready. Handles retry with exponential backoff.

import mongoose from 'mongoose'
import { createReadStream, createWriteStream } from 'fs'
import { stat, unlink } from 'fs/promises'
import { pipeline } from 'stream/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { MediaJob, File, Settings } from '#schema'
import { loadSettings } from '#methods/settings/cache.js'
import { getMediaProcessor } from '#methods/media/index.js'
import { getStorageAdapter } from '#methods/files/index.js'
import patchAttachmentDimensions from '#methods/files/patchAttachmentDimensions.js'
import logger from '#methods/utils/logger.js'
import redactUri from '#methods/utils/redactUri.js'

const MONGO_URI    = process.env.MONGO_URI || 'mongodb://localhost:27017/kowloon'
const POLL_MS      = parseInt(process.env.MEDIA_POLL_INTERVAL_MS || '5000', 10)
const CONCURRENCY  = parseInt(process.env.MEDIA_CONCURRENCY || '2', 10)
const JOB_TTL_MS   = 7 * 24 * 60 * 60 * 1000 // 7 days
// Claim lease + heartbeat: a crashed/killed worker used to leave its job in
// 'processing' forever. The heartbeat keeps a live (long ffmpeg) job's lease fresh.
const LEASE_MS     = 15 * 60 * 1000
const HEARTBEAT_MS = 60 * 1000

async function runJob(job) {
  const storage   = await getStorageAdapter()
  const processor = getMediaProcessor()

  logger.info('[media-worker] Processing job', { fileId: job.fileId, mimeType: job.mimeType })

  // Stream the raw file to a temp file instead of buffering it in memory
  // (videos can be hundreds of MB; ffmpeg needs a file on disk anyway).
  const inPath = join(tmpdir(), `kowloon-media-${randomUUID()}`)
  let outPath = null
  try {
    await pipeline(await storage.getStream(job.storageKey), createWriteStream(inPath))

    if (job.mimeType.startsWith('video/')) {
      outPath = await processor.processVideoFile(inPath, job.mimeType)
    } else if (job.mimeType.startsWith('audio/')) {
      outPath = await processor.processAudioFile(inPath, job.mimeType)
    }

    // Probe the original, not the processed output — faststart remuxing
    // doesn't change pixel dimensions, and this lets dimension extraction
    // happen even when no processing was needed.
    const dims = await processor.probeDimensionsFile(inPath, job.mimeType).catch((err) => {
      logger.warn('[media-worker] Dimension probe failed', { fileId: job.fileId, error: err.message })
      return null
    })

    await finishJob({ job, storage, outPath, dims })
  } finally {
    await unlink(inPath).catch(() => {})
    if (outPath) await unlink(outPath).catch(() => {})
  }
}

async function finishJob({ job, storage, outPath, dims }) {
  if (outPath) {
    // Replace the raw upload with the processed version at the same key
    const { size } = await stat(outPath)
    await storage.replace(job.storageKey, createReadStream(outPath), {
      contentType: job.mimeType,
      contentLength: size,
      isPublic: false,
    })
    await File.findOneAndUpdate(
      { id: job.fileId },
      { processingStatus: 'ready', size, ...(dims ? { width: dims.width, height: dims.height } : {}) }
    )
  } else {
    // Processor returned null — format needs no processing (already progressive)
    await File.findOneAndUpdate(
      { id: job.fileId },
      { processingStatus: 'ready', ...(dims ? { width: dims.width, height: dims.height } : {}) }
    )
  }

  // The post/page that referenced this file was likely created before this
  // job finished, snapshotting width/height as null — patch it now (#54).
  if (dims) {
    await patchAttachmentDimensions(job.fileId, dims)
  }
}

// Requeue jobs whose worker died mid-job (lease expired; pre-lease claims
// count as expired LEASE_MS after their last update). attempts was already
// incremented at claim, so a job that keeps crashing the worker still ends
// up 'failed' after maxAttempts instead of looping forever.
async function recoverExpiredLeases() {
  const now = new Date()
  const stale = await MediaJob.find({
    status: 'processing',
    $or: [
      { leaseUntil: { $lt: now } },
      { leaseUntil: null, updatedAt: { $lt: new Date(now.getTime() - LEASE_MS) } },
    ],
  }).select('_id fileId attempts maxAttempts').lean()

  for (const job of stale) {
    const exhausted = job.attempts >= job.maxAttempts
    const res = await MediaJob.updateOne(
      { _id: job._id, status: 'processing' },
      {
        $set: exhausted
          ? { status: 'failed', error: 'Worker stopped mid-job (lease expired)', expiresAt: new Date(now.getTime() + JOB_TTL_MS) }
          : { status: 'pending', nextAttemptAt: now, error: 'Requeued: worker stopped mid-job' },
        $unset: { leaseUntil: 1 },
      }
    )
    if (res.modifiedCount && exhausted) {
      await File.findOneAndUpdate({ id: job.fileId }, { processingStatus: 'failed' })
    }
    if (res.modifiedCount) {
      logger.warn('[media-worker] Recovered expired lease', { fileId: job.fileId, exhausted })
    }
  }
}

async function pollOnce() {
  await recoverExpiredLeases()

  const jobs = await MediaJob.find({
    status: 'pending',
    nextAttemptAt: { $lte: new Date() },
  }).limit(CONCURRENCY).lean()

  if (jobs.length === 0) return

  await Promise.allSettled(
    jobs.map(async (job) => {
      // Atomic claim — prevents two worker instances from double-processing
      const claimed = await MediaJob.findOneAndUpdate(
        { _id: job._id, status: 'pending' },
        { $set: { status: 'processing', leaseUntil: new Date(Date.now() + LEASE_MS) }, $inc: { attempts: 1 } },
        { new: true }
      )
      if (!claimed) return // Another instance grabbed it

      const heartbeat = setInterval(() => {
        MediaJob.updateOne(
          { _id: claimed._id, status: 'processing' },
          { $set: { leaseUntil: new Date(Date.now() + LEASE_MS) } }
        ).catch((err) => logger.warn('[media-worker] Lease heartbeat failed', { error: err.message }))
      }, HEARTBEAT_MS)

      try {
        await runJob(claimed)

        await MediaJob.findByIdAndUpdate(claimed._id, {
          status: 'done',
          processedAt: new Date(),
          expiresAt: new Date(Date.now() + JOB_TTL_MS),
        })
        logger.info('[media-worker] Job done', { fileId: claimed.fileId })
      } catch (err) {
        logger.error('[media-worker] Job error', { fileId: claimed.fileId, error: err.message, attempts: claimed.attempts })

        const exhausted = claimed.attempts >= claimed.maxAttempts
        // Exponential backoff: 1m, 2m, 4m …capped at 30m
        const backoffMs = Math.min(60_000 * Math.pow(2, claimed.attempts - 1), 30 * 60_000)

        await MediaJob.findByIdAndUpdate(claimed._id, {
          status: exhausted ? 'failed' : 'pending',
          error: err.message,
          ...(exhausted
            ? { expiresAt: new Date(Date.now() + JOB_TTL_MS) }
            : { nextAttemptAt: new Date(Date.now() + backoffMs) }
          ),
        })

        if (exhausted) {
          await File.findOneAndUpdate({ id: claimed.fileId }, { processingStatus: 'failed' })
          logger.error('[media-worker] Job permanently failed', { fileId: claimed.fileId })
        }
      } finally {
        clearInterval(heartbeat)
      }
    })
  )
}

async function main() {
  logger.info('[media-worker] Starting', { mongoUri: redactUri(MONGO_URI), pollMs: POLL_MS, concurrency: CONCURRENCY })

  try {
    await mongoose.connect(MONGO_URI)
    logger.info('[media-worker] MongoDB connected')
    await loadSettings(Settings)
    logger.info('[media-worker] Settings loaded')
  } catch (err) {
    logger.error('[media-worker] Startup failed', { error: err.message })
    process.exit(1)
  }

  let running = true

  const shutdown = async (signal) => {
    logger.info(`[media-worker] ${signal} received, shutting down`)
    running = false
    await mongoose.disconnect()
    process.exit(0)
  }

  process.on('SIGINT',  () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  logger.info('[media-worker] Polling for jobs')

  while (running) {
    try {
      await pollOnce()
    } catch (err) {
      logger.error('[media-worker] Poll error', { error: err.message })
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

main().catch((err) => {
  console.error('[media-worker] Fatal:', err)
  process.exit(1)
})
