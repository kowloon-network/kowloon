import mongoose from 'mongoose'
const { Schema } = mongoose

// A backup or restore. Finished backups are kept for as long as their
// archive exists (they're the list in Settings -> Maintenance); failed jobs
// and restores expire after 48 hours.
const BackupJobSchema = new Schema(
  {
    type:         { type: String, enum: ['backup', 'restore'], required: true },
    status:       { type: String, enum: ['pending', 'running', 'done', 'failed'], default: 'pending', index: true },
    requestedBy:  { type: String, required: true },  // user ID, or "schedule"
    // What the backup holds: the database only, or the database and every
    // uploaded file. Database-only backups are small; full ones carry all
    // the media and are what fill a disk.
    kind:         { type: String, enum: ['database', 'full'], default: 'full' },
    trigger:      { type: String, enum: ['manual', 'scheduled'], default: 'manual' },
    sizeBytes:    { type: Number },
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
    expiresAt:    { type: Date },     // TTL -- failed jobs and restores only
  },
  { timestamps: true }
)

BackupJobSchema.index({ status: 1, createdAt: -1 })
BackupJobSchema.index({ status: 1, leaseUntil: 1 })
BackupJobSchema.index({ trigger: 1, kind: 1, createdAt: -1 })
BackupJobSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export default mongoose.model('BackupJob', BackupJobSchema)
