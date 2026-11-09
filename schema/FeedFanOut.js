// /schema/FeedFanOut.js
// Feed addressing lookup table
// Maps FeedItems to their audience for efficient timeline queries
//
// Query pattern: FeedFanOut.find({ actorId: { $in: following }, to: { $in: ['@public', '@server', myId] } })
// Then join with FeedItems to get content

import mongoose from "mongoose";
const { Schema } = mongoose;

const FeedFanOutSchema = new Schema(
  {
    // Source object
    feedItemId: { type: String, required: true, index: true }, // FeedItems.id
    objectType: { type: String, required: true }, // Post/Reply/Page/etc

    // Author of the post (for filtering by who I follow)
    actorId: { type: String, required: true, index: true },

    // Audience - who can see this post
    // Values: "@public", "@server", or specific user actorId
    to: { type: String, required: true, index: true },

    // Optional: Group ID if this is a group post (for group feed filtering)
    groupId: { type: String, default: null, index: true },

    // Why this audience was set (for analytics/debugging)
    reason: {
      type: String,
      enum: ["public", "server", "circle", "group"],
      default: "public",
    },

    // Capability policies (for computing canReply/canReact per viewer)
    canReply: { type: String, default: "public" },
    canReact: { type: String, default: "public" },

    // UX flags (per-user state for private posts)
    seenAt: { type: Date, default: null },
    hidden: { type: Boolean, default: false },

    // Deduplication (hash of feedItemId + to)
    dedupeHash: { type: String, unique: true, sparse: true },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Primary query: timeline for a user
// Find posts from people I follow that are public, server, or addressed to me
FeedFanOutSchema.index({ actorId: 1, to: 1, createdAt: -1 });

// Paged timeline (getTimeline): newest-first by createdAt with an _id
// tie-break cursor, for each `to` value ("@public"/"@server"/viewerId).
FeedFanOutSchema.index({ to: 1, createdAt: -1, _id: -1 });

// Find all entries for a specific post (for deletion/updates)
FeedFanOutSchema.index({ feedItemId: 1 });

// Group feed: posts in a specific group from people I follow
FeedFanOutSchema.index({ groupId: 1, actorId: 1, createdAt: -1 });

// Virtual for id (maps _id to id for consistency)
FeedFanOutSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

export default mongoose.model("FeedFanOut", FeedFanOutSchema);
