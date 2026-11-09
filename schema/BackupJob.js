import mongoose from 'mongoose'
const { Schema } = mongoose

const BackupJobSchema = new Schema(
  {
    type:         { type: String, enum: ['backup', 'restore'], required: true },
    status:       { type: String, enum: ['pending', 'running', 'done', 'failed'], default: 'pending', index: true },
    requestedBy:  { type: String, required: true },  // user ID
    progress:     {
      stage: { type: String, default: '' },
      pct:   { type: Number, default: 0 },
    },
    archiveKey:   { type: String },   // S3 key for the archive (backup output or restore input)
    archiveName:  { type: String },   // human-readable filename
    error:        { type: String },
    // Claim lease, renewed by a heartbeat while running. Expired 'running'
    // jobs (crashed worker) are recovered on the next tick.
    leaseUntil:   { type: Date },
    expiresAt:    { type: Date },     // TTL — auto-deleted 48h after completion
  },
  { timestamps: true }
)

BackupJobSchema.index({ status: 1, createdAt: -1 })
BackupJobSchema.index({ status: 1, leaseUntil: 1 })
BackupJobSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export default mongoose.model('BackupJob', BackupJobSchema)
