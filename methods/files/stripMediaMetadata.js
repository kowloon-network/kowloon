// methods/files/stripMediaMetadata.js
// Remove metadata from uploaded audio and video before it is stored.
//
// Phone videos carry the place they were shot (QuickTime
// com.apple.quicktime.location.ISO6709 / the ©xyz atom), the device, and
// the time; voice memos can carry location too. Images get this stripped by
// re-encoding (validateUpload.js); audio and video used to be stored exactly
// as uploaded. This remuxes with ffmpeg -- no re-encode, so it's fast and
// lossless -- keeping only the main video and audio streams and dropping
// every metadata tag, chapter and data track (iPhone timed-metadata tracks
// can also hold location).

import { spawn } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { unlink } from 'fs/promises'
import logger from '#methods/utils/logger.js'

// Output container per type, so ffmpeg writes the same format it was given.
const FORMAT = {
  'video/mp4': ['mp4', 'mp4'],
  'video/x-m4v': ['mp4', 'mp4'],
  'video/quicktime': ['mov', 'mov'],
  'video/webm': ['webm', 'webm'],
  'video/ogg': ['ogg', 'ogg'],
  'audio/mpeg': ['mp3', 'mp3'],
  'audio/ogg': ['ogg', 'ogg'],
  'audio/opus': ['ogg', 'opus'],
  'audio/wav': ['wav', 'wav'],
  'audio/flac': ['flac', 'flac'],
  'audio/aac': ['adts', 'aac'],
  'audio/mp4': ['ipod', 'm4a'],
  'audio/webm': ['webm', 'webm'],
}

function run(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    const err = []
    proc.stderr.on('data', (d) => err.push(d))
    proc.on('error', reject)
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(Buffer.concat(err).toString().slice(-400)))
    )
  })
}

/**
 * Returns the path of a cleaned copy (the caller deletes it), or null when
 * the type isn't handled or ffmpeg isn't installed. Throws when ffmpeg is
 * there but can't read the file -- better to refuse the upload than store
 * it with the uploader's location in it.
 */
export async function stripMediaMetadata(inPath, mimeType) {
  const format = FORMAT[mimeType]
  if (!format) return null
  const [muxer, ext] = format
  const isAudio = mimeType.startsWith('audio/')
  const out = join(tmpdir(), `kowloon-strip-${randomUUID()}.${ext}`)
  const args = [
    '-y', '-v', 'error',
    '-i', inPath,
    // Default stream selection: the best video and audio stream only, so
    // data/metadata tracks are left behind. Audio drops embedded cover art.
    ...(isAudio ? ['-vn'] : []),
    '-map_metadata', '-1',
    '-map_metadata:s:v', '-1',
    '-map_metadata:s:a', '-1',
    '-map_chapters', '-1',
    '-c', 'copy',
    ...(muxer === 'mp4' || muxer === 'mov' || muxer === 'ipod' ? ['-movflags', '+faststart'] : []),
    '-f', muxer,
    out,
  ]
  try {
    await run(args)
    return out
  } catch (err) {
    await unlink(out).catch(() => {})
    if (err.code === 'ENOENT') {
      logger.warn('[upload] ffmpeg is not installed; audio/video metadata (including location) is NOT being removed')
      return null
    }
    throw new Error(`Couldn't process this ${isAudio ? 'audio' : 'video'} file`)
  }
}
