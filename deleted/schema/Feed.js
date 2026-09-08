// /schema/Feed.js
import mongoose from "mongoose";

const { Schema } = mongoose;

/**
 * Feed = per-viewer fan-out rows
 * - NO 'to' here: presence of the row implies view permission.
 * - Store per-viewer action capabilities, which may differ per actor.
 */
const FeedSchema = new Schema(
  {
    // Viewer & target
    actorId: { type: String, required: true, index: true }, // local viewer
    objectId: { type: String, required: true, index: true }, // FeedItems.id (global)

    // Author for quick render/filter
    activityActorId: { type: String, required: true, index: true }, // object author

    // Object typing for efficient filtering (denormalized from FeedItems)
    type: {
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
    }, // Overall type (e.g., "Post", "Bookmark", "Page")
    objectType: { type: String, default: undefined, index: true }, // Subtype (e.g., "Note", "Article", "Folder")

    // Why it's in this feed (coarse, non-leaky)
    reason: {
      type: String,
      enum: ["domain", "follow", "audience", "mention", "self"],
      index: true,
    },

    // Render + sort
    // createdAt: { type: Date, required: true }, // usually FeedItems.publishedAt
    fetchedAt: { type: Date, default: () => new Date() },

    // Tiny snapshot for list UIs (keep minimal)
    snapshot: {
      type: Object, // e.g., { title, excerpt, media: [thumbUrls], visibilityLabel }
      default: undefined,
    },

    // Per-viewer action capabilities (computed at ingest)
    canReply: { type: Boolean, default: false },
    canReact: { type: Boolean, default: false },

    // UX flags
    seenAt: { type: Date, default: null },
    hidden: { type: Boolean, default: false },
    pinned: { type: Boolean, default: false },
    rank: { type: Number, default: 0 },
  },
  {
    strict: false,
    timestamps: true, // also keeps updatedAt for edits (pin/hide)
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// De-dup per viewer/object; fast timeline sorts
FeedSchema.index({ actorId: 1, objectId: 1 }, { unique: true });
FeedSchema.index({ actorId: 1, createdAt: -1, _id: -1 });
FeedSchema.index({ actorId: 1, reason: 1, createdAt: -1 });
FeedSchema.index({ actorId: 1, type: 1, createdAt: -1 }); // Type-filtered feeds
FeedSchema.index({ actorId: 1, type: 1, objectType: 1, createdAt: -1 }); // Subtype-filtered feeds

export default mongoose.model("Feed", FeedSchema);
