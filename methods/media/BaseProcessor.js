// methods/media/BaseProcessor.js
// Abstract interface for all media processor adapters.
// Implementations live in processors/<name>.js.

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
}
