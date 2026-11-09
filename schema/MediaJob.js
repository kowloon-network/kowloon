// schema/MediaJob.js — async media processing job queue
import mongoose from 'mongoose'
const { Schema } = mongoose

const MediaJobSchema = new Schema({
  fileId:       { type: String, required: true, index: true },
  storageKey:   { type: String, required: true },
  mimeType:     { type: String, required: true },
  status:       { type: String, enum: ['pending', 'processing', 'done', 'failed'], default: 'pending', index: true },
  attempts:     { type: Number, default: 0 },
  maxAttempts:  { type: Number, default: 3 },
  nextAttemptAt: { type: Date, default: Date.now, index: true },
  processorUsed: { type: String },
  error:        { type: String },
  processedAt:  { type: Date },
  // Claim lease: a 'processing' job whose lease expired (worker crashed /
  // was killed mid-job) is requeued by the worker's next tick.
  leaseUntil:   { type: Date },
  // TTL: completed/failed records expire 7 days after processing
  expiresAt:    { type: Date },
}, { timestamps: true })

MediaJobSchema.index({ status: 1, nextAttemptAt: 1 })
MediaJobSchema.index({ status: 1, leaseUntil: 1 })
MediaJobSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export default mongoose.model('MediaJob', MediaJobSchema)
