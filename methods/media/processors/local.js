// methods/media/processors/local.js
// Local media processor: Sharp for images, FFmpeg faststart for MP4/MOV.
// FFmpeg must be on PATH (installed via system package manager / Dockerfile).

import { spawn } from 'child_process'
import { writeFile, readFile, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { BaseProcessor } from '../BaseProcessor.js'

// Only these containers need the faststart moov-atom move.
// WebM and OGG are already streaming-friendly formats.
const FASTSTART_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/x-m4v'])

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: 'pipe' })
    const stderr = []
    proc.stderr.on('data', (d) => stderr.push(d))
    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error('ffmpeg not found on PATH. Install ffmpeg on the server.'))
      } else {
        reject(err)
      }
    })
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(stderr).toString().slice(-500)}`))
    })
  })
}

// ffprobe ships alongside ffmpeg in the same package (apk/apt/brew) — no
// separate install step needed anywhere ffmpeg is already required.
function runFFprobe(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', args, { stdio: 'pipe' })
    const stdout = []
    const stderr = []
    proc.stdout.on('data', (d) => stdout.push(d))
    proc.stderr.on('data', (d) => stderr.push(d))
    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error('ffprobe not found on PATH. Install ffmpeg (bundles ffprobe) on the server.'))
      } else {
        reject(err)
      }
    })
    proc.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString())
      else reject(new Error(`ffprobe exited ${code}: ${Buffer.concat(stderr).toString().slice(-500)}`))
    })
  })
}

export class LocalProcessor extends BaseProcessor {
  async processVideo(buffer, mimeType) {
    if (!FASTSTART_TYPES.has(mimeType)) return null // already progressive

    const id = randomUUID()
    const input  = join(tmpdir(), `kowloon-${id}-in.mp4`)
    const output = join(tmpdir(), `kowloon-${id}-out.mp4`)

    try {
      await writeFile(input, buffer)
      await runFFmpeg([
        '-y',
        '-i', input,
        '-movflags', '+faststart',
        '-c', 'copy',    // no re-encode — just move the moov atom
        output,
      ])
      return await readFile(output)
    } finally {
      await unlink(input).catch(() => {})
      await unlink(output).catch(() => {})
    }
  }

  async processImage(buffer, mimeType, options = {}) {
    const { maxDimension = 2048 } = options
    const { default: sharp } = await import('sharp')

    const meta = await sharp(buffer).metadata()
    const { width = 0, height = 0 } = meta

    if (Math.max(width, height) <= maxDimension) return null // already within limits

    const pipeline = sharp(buffer).rotate() // honour EXIF orientation
    const resized = width >= height
      ? pipeline.resize(maxDimension, null, { withoutEnlargement: true })
      : pipeline.resize(null, maxDimension, { withoutEnlargement: true })

    const outBuffer = await resized.toBuffer()
    const outMeta = await sharp(outBuffer).metadata()
    return { buffer: outBuffer, width: outMeta.width ?? width, height: outMeta.height ?? height }
  }

  // Audio is already progressive in browsers — no processing needed.
  async processAudio(_buffer, _mimeType) {
    return null
  }

  async probeDimensions(buffer, mimeType) {
    if (!mimeType.startsWith('video/')) return null

    const id = randomUUID()
    const input = join(tmpdir(), `kowloon-${id}-probe.mp4`)

    try {
      await writeFile(input, buffer)
      const stdout = await runFFprobe([
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height',
        '-of', 'json',
        input,
      ])
      const stream = JSON.parse(stdout)?.streams?.[0]
      if (!stream?.width || !stream?.height) return null
      return { width: stream.width, height: stream.height }
    } catch (err) {
      return null
    } finally {
      await unlink(input).catch(() => {})
    }
  }
}
