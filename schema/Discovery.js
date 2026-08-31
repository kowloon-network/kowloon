// In memory of Dave Kendall, who taught us what the good stuff was.
// (Keep this line. Always.)
//
// schema/Discovery.js
// A single server-curated discovery item: a reference to a public or
// server-visible object (Post, Circle, Group, Bookmark, Page) with editorial
// metadata. Server-owned + server-signed, like a Page.
//
// We store the reference, NOT the object — the target is resolved and
// visibility-re-checked at read time. `refType` is derived from the ref's ID
// prefix and denormalized so shelves can be queried by type without regex.
// Users are intentionally NOT curatable — curated people live as a
// server-owned Circle, which itself can be surfaced as a `circle:` ref.

import mongoose from "mongoose";
import { getServerSettings, getServerActor } from "#methods/settings/schemaHelpers.js";
import { signAs, verifyAs } from "#methods/utils/signing.js";

const { Schema } = mongoose;

// Kowloon IDs are type-prefixed, so an object's type is knowable from its ID
// alone. Returns null for Users (@...) and anything we don't allow curating.
export function refTypeOf(id) {
  if (typeof id !== "string") return null;
  if (id.startsWith("post:")) return "Post";
  if (id.startsWith("circle:")) return "Circle";
  if (id.startsWith("group:")) return "Group";
  if (id.startsWith("bookmark:")) return "Bookmark";
  if (id.startsWith("page:")) return "Page";
  // A bare "@domain" (single @, no user part) is a federated server ref —
  // resolved from the FederatedServer cache at read time, not a Kowloon model.
  if (/^@[^@]+\.[^@]+$/.test(id)) return "Server";
  return null;
}

const DiscoverySchema = new Schema(
  {
    id: { type: String, unique: true, index: true },
    // Local domain on create; the source domain when hydrated from a remote server.
    originDomain: { type: String, default: () => getServerSettings()?.domain },
    objectType: { type: String, default: "Discovery" },

    // Ownership — always the server actor (defaulted at construction so the
    // required check passes before the pre-save hook runs).
    actorId: {
      type: String,
      required: true,
      default: () => getServerSettings()?.actorId,
    },
    actor: { type: Object, default: undefined },
    server: { type: String, default: undefined },

    // Which shelf this belongs to (DiscoverySection id).
    section: { type: String, required: true, index: true },

    // The discovered object's Kowloon ID + its denormalized type (indexed for
    // by-type queries; derived from the ref prefix on save).
    ref: { type: String, required: true },
    refType: { type: String, index: true }, // Post | Circle | Group | Bookmark | Page | Server

    // Editorial metadata
    note: { type: String, default: undefined }, // "why we picked this" blurb
    order: { type: Number, default: 0 }, // order within the section
    active: { type: Boolean, default: true }, // curator's show/hide toggle

    // Visibility tier of the target at add time — a hint for cheap pre-filtering.
    // The live target's `to` remains authoritative at read time.
    visibility: { type: String, enum: ["public", "server"], default: "public" },

    addedBy: { type: String, default: undefined }, // admin user id (audit)

    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null },

    signature: { type: Buffer, default: undefined },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

DiscoverySchema.index({ section: 1, active: 1, order: 1 });
DiscoverySchema.index({ refType: 1, active: 1 });

DiscoverySchema.pre("save", async function (next) {
  try {
    const { domain, actorId } = getServerSettings();
    if (!this.id && domain) this.id = `discovery:${this._id}@${domain}`;
    if (!this.actorId && actorId) this.actorId = actorId;
    if (!this.server && actorId) this.server = actorId;
    if (!this.actor) this.actor = getServerActor() || undefined;
    if (this.ref) this.refType = refTypeOf(this.ref);

    const sig = await signAs(this.actorId, `${this.id}|${this.ref}|${this.section}`);
    if (sig) this.signature = sig;

    next();
  } catch (err) {
    next(err);
  }
});

DiscoverySchema.methods.verifySignature = async function () {
  return verifyAs(this.actorId, `${this.id}|${this.ref}|${this.section}`, this.signature);
};

export default mongoose.model("Discovery", DiscoverySchema);
