import mongoose from "mongoose";
import { Settings } from "./index.js";
import { getServerSettings } from "#methods/settings/schemaHelpers.js";
const Schema = mongoose.Schema;

// Delivery subdocument: one per remote target
const DeliverySchema = new Schema(
  {
    target: { type: String, required: true }, // actorId or server scope
    inboxUrl: { type: String, required: true }, // concrete HTTPS endpoint
    host: { type: String, required: true }, // eTLD+1 for scheduling
    status: {
      type: String,
      enum: ["pending", "delivering", "delivered", "failed", "skipped"],
      default: "pending",
    },
    attempts: { type: Number, default: 0 },
    lastAttemptAt: { type: Date, default: null },
    nextAttemptAt: { type: Date, default: null },
    // Claim lease: set when a worker atomically claims this delivery
    // (pending -> delivering). If the worker dies mid-send, the delivery is
    // re-queued once the lease expires instead of being stuck forever.
    leaseUntil: { type: Date, default: null },
    responseStatus: { type: Number, default: null },
    responseHeaders: { type: Object, default: null },
    responseBody: { type: String, default: null }, // size-capped
    error: { type: Object, default: null }, // { message, code, class }
    idempotencyKey: { type: String, required: true }, // for retries
    remoteActivityId: { type: String, default: null }, // from Location header
    signatureKeyId: { type: String, default: null }, // which key used
    metrics: {
      type: Object,
      default: () => ({ latencyMs: null, bytesSent: null, bytesReceived: null }),
    },
  },
  { _id: true, timestamps: true }
);

const OutboxSchema = new Schema(
  {
    id: String,
    activityId: { type: String, required: true }, // the saved local Activity id
    activity: { type: Object, required: true }, // immutable snapshot
    createdBy: { type: String, required: true }, // actorId of caller
    audience: { type: [String], default: [] }, // resolved recipients
    status: {
      type: String,
      enum: ["pending", "delivering", "partial", "delivered", "error"],
      default: "pending",
    },
    counts: {
      type: Object,
      default: () => ({ total: 0, pending: 0, delivered: 0, failed: 0, skipped: 0 }),
    },
    lastAttemptedAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    error: { type: Object, default: null }, // job-level errors only
    reason: { type: String, default: "" }, // why federate: true
    dedupeHash: { type: String, unique: true, sparse: true }, // prevent duplicate fan-outs
    ttl: { type: Date, default: null, expires: 0 }, // TTL index - automatic cleanup
    deliveries: { type: [DeliverySchema], default: [] }, // per-recipient state
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
    collection: "outbox",
  }
);

// Indexes for worker queries
OutboxSchema.index({ status: 1, "counts.pending": 1, lastAttemptedAt: 1 });
OutboxSchema.index({ "deliveries.status": 1, "deliveries.nextAttemptAt": 1 });
OutboxSchema.index({ "deliveries.host": 1 });
// TTL index is already created by 'expires: 0' option on the ttl field above

OutboxSchema.pre("save", async function (next) {
  // Create the activity id and url
  const { domain } = getServerSettings();
  this.id = this.id || `outbox:${this._id}@${domain}`;

  // Compute job status from deliveries
  if (this.deliveries && this.deliveries.length > 0) {
    const statuses = this.deliveries.map((d) => d.status);
    const allDelivered = statuses.every((s) => s === "delivered" || s === "skipped");
    const anyDelivering = statuses.some((s) => s === "delivering");
    const anyFailed = statuses.some((s) => s === "failed");
    const anyDelivered = statuses.some((s) => s === "delivered");

    if (allDelivered) {
      this.status = "delivered";
      if (!this.deliveredAt) this.deliveredAt = new Date();
    } else if (anyDelivering) {
      this.status = "delivering";
    } else if (anyDelivered || anyFailed) {
      this.status = "partial";
    } else {
      this.status = "pending";
    }

    // Update counts
    this.counts = {
      total: this.deliveries.length,
      pending: statuses.filter((s) => s === "pending").length,
      delivered: statuses.filter((s) => s === "delivered").length,
      failed: statuses.filter((s) => s === "failed").length,
      skipped: statuses.filter((s) => s === "skipped").length,
    };
  }

  next();
});

export default mongoose.model("Outbox", OutboxSchema);
