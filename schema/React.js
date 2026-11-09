import mongoose from "mongoose";
const Schema = mongoose.Schema;
const ObjectId = mongoose.Types.ObjectId;
import { Settings } from "./index.js";
import { getServerSettings } from "#methods/settings/schemaHelpers.js";

const ReactSchema = new Schema(
  {
    id: { type: String },
    type: { type: String, default: "React" },
    target: { type: String, required: true },
    actorId: { type: String, required: true },
    actor: { type: Object, default: undefined },
    server: { type: String, default: undefined },
    emoji: { type: String, required: true },
    name: { type: String, required: true },
    deletedAt: Date,
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

ReactSchema.pre("save", async function (next) {
  const { domain, actorId } = getServerSettings();
  this.id = this.id || `react:${this._id}@${domain}`;
  this.server = this.server || actorId;
  next();
});
// `key: true` is not a Mongoose option -- `id` was never indexed, so every
// findOne({ id }) was a collection scan. Partial (string-only) so any legacy
// doc missing `id` can't block the unique build.
ReactSchema.index({ id: 1 }, { unique: true, partialFilterExpression: { id: { $type: "string" } } });
// One reaction per user per target, enforced by the DB (the handler upserts
// on this key). Run scripts/dedupe-activity-keys.js --apply before deploying.
ReactSchema.index({ actorId: 1, target: 1 }, { unique: true });
ReactSchema.index({ target: 1 }); // per-target aggregates / counts

export default mongoose.model("React", ReactSchema);
