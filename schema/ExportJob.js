import mongoose from 'mongoose'
const { Schema } = mongoose

// A "Download my data" request. The backup worker (workers/backup.js) builds
// a zip of everything the person made and stores it under _exports/ in the
// bucket; they download it from settings until it expires. Expired and
// failed jobs are pruned by the worker, which also deletes the zip (a TTL
// index alone would orphan the object in storage).
const ExportJobSchema = new Schema(
  {
    actorId:     { type: String, required: true, index: true },
    status:      { type: String, enum: ['pending', 'running', 'done', 'failed'], default: 'pending', index: true },
    archiveKey:  { type: String },
    archiveName: { type: String },
    sizeBytes:   { type: Number },
    stage:       { type: String, default: '' },  // shown in settings while it builds
    error:       { type: String },
    leaseUntil:  { type: Date },
    readyAt:     { type: Date },
    expiresAt:   { type: Date, index: true },
  },
  { timestamps: true }
)

ExportJobSchema.index({ actorId: 1, createdAt: -1 })

export default mongoose.model('ExportJob', ExportJobSchema)
