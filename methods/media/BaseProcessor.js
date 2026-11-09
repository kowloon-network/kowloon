// methods/media/BaseProcessor.js
// Abstract interface for all media processor adapters.
// Implementations live in processors/<name>.js.

import { readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

// Write a processed Buffer to a fresh temp file (caller unlinks it).
async function bufferToTemp(buf) {
  if (!buf) return null
  const out = join(tmpdir(), `kowloon-media-${randomUUID()}-out`)
  await writeFile(out, buf)
  return out
}

export class BaseProcessor {
  // Returns a processed Buffer, or null if no processing is needed.
  // null → worker marks file ready immediately without re-uploading.
  async processVideo(buffer, mimeType) {
    throw new Error('processVideo() not implemented')
  }

  // Returns { buffer, width, height } or null if no resize was needed.
  async processImage(buffer, mimeType, options = {}) {
    throw new Error('processImage() not implemented')
  }

  // Returns a processed Buffer, or null (most audio is already progressive).
  async processAudio(buffer, mimeType) {
    return null
  }

  // Returns { width, height } for video, or null (no dimensions to report —
  // e.g. audio, or extraction failed/unsupported). Distinct from
  // processVideo(): dimension probing never needs to happen for images
  // (processImage already returns width/height inline) and shouldn't block
  // the transcode/remux step if it fails.
  async probeDimensions(buffer, mimeType) {
    return null
  }

  // ── File-path variants (used by workers/mediaProcessor.js) ────────────────
  // The worker streams media to a temp file rather than holding it in memory.
  // These defaults fall back to the Buffer methods; processors that can work
  // on files directly (LocalProcessor/ffmpeg) override them.
  // processVideoFile/processAudioFile return a temp output path (the caller
  // unlinks it) or null when no processing is needed.
  async processVideoFile(inPath, mimeType) {
    return bufferToTemp(await this.processVideo(await readFile(inPath), mimeType))
  }

  async processAudioFile(inPath, mimeType) {
    return bufferToTemp(await this.processAudio(await readFile(inPath), mimeType))
  }

  async probeDimensionsFile(inPath, mimeType) {
    return this.probeDimensions(await readFile(inPath), mimeType)
  }
}
