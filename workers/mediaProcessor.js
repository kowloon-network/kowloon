#!/usr/bin/env node
// workers/mediaProcessor.js — async media processing worker
// Polls the MediaJob queue, runs the configured processor adapter, and marks
// files ready. Handles retry with exponential backoff.

import mongoose from 'mongoose'
import { MediaJob, File, Settings } from '#schema'
import { loadSettings } from '#methods/settings/cache.js'
import { getMediaProcessor } from '#methods/media/index.js'
import { getStorageAdapter } from '#methods/files/index.js'
import patchAttachmentDimensions from '#methods/files/patchAttachmentDimensions.js'
import logger from '#methods/utils/logger.js'

const MONGO_URI    = process.env.MONGO_URI || 'mongodb://localhost:27017/kowloon'
const POLL_MS      = parseInt(process.env.MEDIA_POLL_INTERVAL_MS || '5000', 10)
const CONCURRENCY  = parseInt(process.env.MEDIA_CONCURRENCY || '2', 10)
const JOB_TTL_MS   = 7 * 24 * 60 * 60 * 1000 // 7 days

async function bufferFromStream(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function runJob(job) {
  const storage   = await getStorageAdapter()
  const processor = getMediaProcessor()

  logger.info('[media-worker] Processing job', { fileId: job.fileId, mimeType: job.mimeType })

  // Download the raw file
  const stream = await storage.getStream(job.storageKey)
  const buffer = await bufferFromStream(stream)

  let processed = null

  if (job.mimeType.startsWith('video/')) {
    processed = await processor.processVideo(buffer, job.mimeType)
  } else if (job.mimeType.startsWith('audio/')) {
    processed = await processor.processAudio(buffer, job.mimeType)
  }

  // Probe against the original downloaded buffer, not `processed` — faststart
  // remuxing doesn't change pixel dimensions, and this lets dimension
  // extraction happen even when processVideo() returns null (no remux needed).
  const dims = await processor.probeDimensions(buffer, job.mimeType).catch((err) => {
    logger.warn('[media-worker] Dimension probe failed', { fileId: job.fileId, error: err.message })
    return null
  })

  if (processed) {
    // Replace the raw upload with the processed version at the same key
    await storage.replace(job.storageKey, processed, {
      contentType: job.mimeType,
      isPublic: false,
    })
    await File.findOneAndUpdate(
      { id: job.fileId },
      { processingStatus: 'ready', size: processed.length, ...(dims ? { width: dims.width, height: dims.height } : {}) }
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

async function pollOnce() {
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
        { $set: { status: 'processing' }, $inc: { attempts: 1 } },
        { new: true }
      )
      if (!claimed) return // Another instance grabbed it

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
      }
    })
  )
}

async function main() {
  logger.info('[media-worker] Starting', { mongoUri: MONGO_URI, pollMs: POLL_MS, concurrency: CONCURRENCY })

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
