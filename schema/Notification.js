// Notification schema for Kowloon
// Notifications are actionable events that users should be aware of

import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema(
  {
    // Unique identifier
    id: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    // Notification type
    type: {
      type: String,
      required: true,
      enum: [
        "reply", // Someone replied to your post
        "react", // Someone reacted to your post
        "follow", // Someone followed you
        "new_post", // Someone you follow posted (opt-in via prefs)
        "mention", // Someone tagged you (@handle) in a post or reply (opt-in via prefs)
        "join_request", // Someone requested to join your group
        "join_approved", // Your join request was approved
        "moderation", // A flag you reported was resolved, or your content was moderated
      ],
      index: true,
    },

    // Who receives this notification
    recipientId: {
      type: String,
      required: true,
      index: true,
    },

    // Who triggered this notification
    actorId: {
      type: String,
      required: true,
    },
    actorName: {
      type: String,
    },
    actorIcon: {
      type: String,
    },

    // What object is involved (if any)
    objectId: {
      type: String,
      index: true,
    },
    objectType: {
      type: String,
      enum: ["Post", "Reply", "Page", "Bookmark", "Group", "React"],
    },

    // The triggering activity (if needed for reference)
    activityId: {
      type: String,
    },
    activityType: {
      type: String,
    },

    // Display information
    summary: {
      type: String,
      required: true,
    },
    href: {
      type: String,
      required: true,
    },

    // Status
    read: {
      type: Boolean,
      default: false,
      index: true,
    },
    dismissed: {
      type: Boolean,
      default: false,
      index: true,
    },

    // For aggregation (e.g., "3 people reacted to your post")
    groupKey: {
      type: String,
      index: true,
    },

    // Timestamps
    createdAt: {
      type: Date,
      default: () => new Date(),
      index: true,
    },
  },
  {
    timestamps: false, // We manage createdAt manually
    collection: "notifications",
  },
);

// Compound indexes for common queries
notificationSchema.index({ recipientId: 1, read: 1, createdAt: -1 });
notificationSchema.index({ recipientId: 1, createdAt: -1 });
notificationSchema.index({ groupKey: 1, createdAt: -1 });

const Notification = mongoose.model("Notification", notificationSchema);

export default Notification;
