import mongoose from "mongoose";
const { Schema } = mongoose;

// One row per background worker, refreshed every minute while it runs.
// GET /health reads these to tell a stopped or stuck worker from a healthy
// one (methods/workers/heartbeat.js).
const WorkerHeartbeatSchema = new Schema(
  {
    name: { type: String, required: true, unique: true }, // outbox | pull | media | backup
    lastBeatAt: { type: Date, required: true },
    startedAt: { type: Date },
    host: { type: String }, // container hostname, for telling replicas apart in logs
  },
  { versionKey: false }
);

export default mongoose.model("WorkerHeartbeat", WorkerHeartbeatSchema);
