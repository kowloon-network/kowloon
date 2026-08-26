// /schema/FeedItems.js
// FeedItems: Canonical object storage with coarse visibility policy
//
// Top-level fields include coarse visibility (to/canReply/canReact) for efficient querying.
// The object field stores sanitized content WITHOUT these fields (no duplication).
// Source tracking and deletion metadata live only in source collections (Post, Reply, etc).
import mongoose from "mongoose";
import { getServerSettings } from "#methods/settings/schemaHelpers.js";

const { Schema } = mongoose;

// Audience + capability enums (no Circle/ID leakage)
export const TO_ENUM = ["public", "server", "audience"]; // who can see in principle
export const CAP_ENUM = ["public", "followers", "audience", "none"]; // who may act in principle

const FeedItemsSchema = new Schema(
  {
    // Canonical identifiers
    id: { type: String, key: true }, // global canonical id (remote as-is; local minted)
    url: { type: String, default: undefined }, // canonical URL (locals minted below)
    server: { type: String, default: undefined }, // originating server

    // Author
    actorId: { type: String, required: true }, // author @user@domain

    // Object typing (matches your pattern)
    objectType: {
      type: String,
      enum: [
        "Post",
        "Reply",
        "Page",
        "Bookmark",
        "File",
        "Group",
        "Circle",
        "Invite",
        "Flag",
        "React",
      ],
      required: true,
      index: true,
    },
    // Subtype (e.g., Post → Note/Article/Media/Link; Bookmark → Folder/Bookmark)
    type: { type: String, default: undefined },

    // Author's publish time — the primary feed sort key. MUST be a typed Date:
    // remote-pulled items arrive with publishedAt as an ISO *string*, and under
    // this schema's `strict: false` an untyped path stores it as-is. MongoDB
    // sorts by BSON type first, so string dates sort below all real Dates and
    // every federated post sinks to the bottom of the feed regardless of recency.
    // Declaring it Date makes Mongoose cast the string on write.
    publishedAt: { type: Date, default: undefined },

    // Threading (optional)
    inReplyTo: { type: String, default: undefined },
    threadRoot: { type: String, default: undefined },

    // Audience targeting (public containers only - Circles are NEVER stored for privacy)
    group: { type: String, default: undefined, index: true }, // Group ID if addressed to a group

    // Normalized content envelope for detail views (sanitized - no to/canReply/canReact/deletedAt/deletedBy/source)
    object: { type: Object, default: undefined },

    // Coarse visibility policy (top-level for efficient queries)
    to: { type: String, enum: TO_ENUM, default: "public", index: true },
    canReply: { type: String, enum: CAP_ENUM, default: "public" },
    canReact: { type: String, enum: CAP_ENUM, default: "public" },

    // Federation freshness
    etag: { type: String, default: undefined },
    lastSyncedAt: { type: Date, default: undefined },

    // Deletion/tombstone (tombstoned only - not deletedAt/deletedBy)
    tombstoned: { type: Boolean, default: false },
  },
  {
    strict: false, // allow handler-specific extras (mirrors Activity pattern)
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Mint id/url/server for LOCAL-origin records; keep remote ids/urls as-is
FeedItemsSchema.pre("save", async function (next) {
  try {
    const { domain, actorId } = getServerSettings();

    if (this.origin === "local" && domain) {
      if (!this.id) {
        const ns = (this.objectType || "object").toLowerCase();
        this.id = `${ns}:${this._id}@${domain}`;
      }
      if (!this.url) {
        const ns = (this.objectType || "objects").toLowerCase();
        this.url = `https://${domain}/${ns}/${this.id}`;
      }
      if (!this.server && actorId) {
        this.server = actorId;
      }
    }

    if (!this.publishedAt) this.publishedAt = this.createdAt || new Date();
    next();
  } catch (err) {
    next(err);
  }
});

// Indexes
FeedItemsSchema.index({ id: 1 }, { unique: true }); // de-dupe
FeedItemsSchema.index({ actorId: 1, publishedAt: -1, _id: -1 }); // author timeline
FeedItemsSchema.index({ originDomain: 1, publishedAt: -1 }); // ops/domain scans
FeedItemsSchema.index({ objectType: 1, publishedAt: -1 }); // type-filtered
FeedItemsSchema.index({ to: 1, publishedAt: -1 }); // public/server/audience scans
FeedItemsSchema.index({ objectType: 1, type: 1, "object.attachments.kind": 1 }); // kind-filtered queries

export default mongoose.model("FeedItems", FeedItemsSchema);
