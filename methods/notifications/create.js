// Helper function to create notifications
// Notifications alert users about actions that involve them

import { Notification, User, Reply } from "#schema";
import mongoose from "mongoose";
import { getServerSettings } from "#methods/settings/schemaHelpers.js";
import sendPush from "#methods/push/send.js";

/**
 * Create a notification
 * @param {Object} params
 * @param {string} params.type - Notification type (reply, react, follow, new_post, join_request, join_approved)
 * @param {string} params.recipientId - User ID who receives the notification
 * @param {string} params.actorId - User ID who triggered the notification
 * @param {string} [params.objectId] - ID of the object involved (post, group, etc.)
 * @param {string} [params.objectType] - Type of the object (Post, Group, etc.)
 * @param {string} [params.activityId] - ID of the triggering activity
 * @param {string} [params.activityType] - Type of the triggering activity
 * @param {string} [params.summary] - Custom summary text (auto-generated if not provided)
 * @param {string} [params.href] - Custom href (auto-generated if not provided)
 * @param {string} [params.groupKey] - Key for aggregating notifications
 * @param {number} [params.cooldownMs] - When set with groupKey, makes this a
 *   "schedulable" notification: it fires only if the most recent one with this
 *   (recipient, groupKey) has been READ *and* is older than cooldownMs. Lets a
 *   type (e.g. new_post) nudge at most once per window, and never pile up while
 *   an earlier one sits unread. Without it, groupKey keeps its legacy dedup.
 * @returns {Promise<Object>} Created notification or null if preferences prevent creation
 */
export default async function createNotification(params) {
  try {
    const {
      type,
      recipientId,
      actorId,
      objectId,
      objectType,
      activityId,
      activityType,
      summary: customSummary,
      href: customHref,
      groupKey,
      cooldownMs,
    } = params;

    // Don't create notification if actor is the recipient (no self-notifications)
    if (actorId === recipientId) {
      return null;
    }

    // Fetch actor info for display
    const actor = await User.findOne({ id: actorId }).select("id profile").lean();
    const actorName = actor?.profile?.name || actorId;
    const actorIcon = actor?.profile?.icon;

    // Generate summary if not provided
    const summary = customSummary || generateSummary(type, actorName, objectType);

    // The app opens notifications at /post/:id, but replies have no standalone
    // page — reacting to / replying to a reply produced a notification pointing
    // at a reply: id, which resolved to "Post Not Found" (#51). Resolve reply
    // targets up to their ancestor post so the tap lands on the thread.
    let navObjectId = objectId;
    if (typeof objectId === "string" && objectId.startsWith("reply:")) {
      let cur = objectId;
      for (let hops = 0; cur && String(cur).startsWith("reply:") && hops < 10; hops++) {
        const r = await Reply.findOne({ id: cur }).select("target threadRoot").lean();
        cur = r?.threadRoot && !String(r.threadRoot).startsWith("reply:")
          ? r.threadRoot
          : r?.target || null;
      }
      if (cur && !String(cur).startsWith("reply:")) navObjectId = cur;
    }

    // Generate href if not provided
    const href = customHref || generateHref(type, navObjectId, objectType);

    // Schedulable notifications (cooldownMs set): fire only if the most recent
    // one with this key has been READ *and* is older than the cooldown. So an
    // unread nudge never multiplies, and someone away for days comes back to a
    // single waiting notification, not a stack.
    if (groupKey && cooldownMs != null) {
      const latest = await Notification.findOne({ recipientId, groupKey })
        .sort({ createdAt: -1 })
        .select("read createdAt");
      if (latest) {
        const withinCooldown = latest.createdAt > new Date(Date.now() - cooldownMs);
        if (!latest.read || withinCooldown) return latest; // suppressed
      }
    }
    // Legacy dedup (groupKey without cooldownMs): skip if an unread one exists
    // within the last 24h. Unchanged for existing callers (reply/react/etc.).
    else if (groupKey) {
      const existing = await Notification.findOne({
        recipientId,
        groupKey,
        read: false,
        createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      });
      if (existing) return existing;
    }

    // Create notification ID using MongoDB ObjectId (same pattern as everything else)
    const { domain } = getServerSettings();
    const mongoId = new mongoose.Types.ObjectId();
    const notifId = `notification:${mongoId.toString()}@${domain}`;

    // Create notification
    const notification = await Notification.create({
      id: notifId,
      type,
      recipientId,
      actorId,
      actorName,
      actorIcon,
      objectId: navObjectId,
      objectType,
      activityId,
      activityType,
      summary,
      href,
      groupKey,
      read: false,
      dismissed: false,
      createdAt: new Date(),
    });

    console.log(`Notification created: ${notifId} (${type}) for ${recipientId}`);

    // Fire-and-forget push to the recipient's registered devices. Only runs for
    // genuinely new notifications (the dedup path returns before this), so
    // coalesced events don't re-buzz. Never blocks or breaks the write.
    const pushBody =
      actorName && summary.startsWith(`${actorName} `)
        ? summary.slice(actorName.length + 1)
        : summary;
    sendPush(recipientId, {
      title: actorName || "Kowloon",
      body: pushBody,
      // objectType + objectId are what the app's notificationRoute() uses to
      // deep-link on tap; type/notificationId are for context.
      data: {
        notificationId: notifId,
        type,
        objectType: objectType || null,
        objectId: navObjectId || null,
        href,
      },
    }).catch(() => {});

    return notification;
  } catch (err) {
    console.error("Failed to create notification:", err.message);
    // Non-fatal: don't block activity if notification creation fails
    return null;
  }
}

/**
 * Generate summary text for notification
 */
function generateSummary(type, actorName, objectType) {
  switch (type) {
    case "reply":
      return `${actorName} replied to your post`;
    case "react":
      return `${actorName} reacted to your post`;
    case "follow":
      return `${actorName} followed you`;
    case "new_post":
      return `${actorName} posted`;
    case "join_request":
      return `${actorName} requested to join your group`;
    case "join_approved":
      return `Your request to join the group was approved`;
    default:
      return `${actorName} performed an action`;
  }
}

/**
 * Generate href for notification
 */
function generateHref(type, objectId, objectType) {
  const { domain } = getServerSettings();
  const protocol = domain === "localhost" ? "http" : "https";
  const baseUrl = `${protocol}://${domain}`;

  if (!objectId) {
    return baseUrl;
  }

  // Parse object ID to get URL path
  // Format: "type:id@domain"
  const match = objectId.match(/^([a-z]+):([^@]+)@/);
  if (match) {
    const [, objType, localId] = match;
    switch (objType) {
      case "post":
        return `${baseUrl}/posts/${localId}`;
      case "reply":
        return `${baseUrl}/posts/${localId}`;
      case "group":
        return `${baseUrl}/groups/${localId}`;
      case "page":
        return `${baseUrl}/pages/${localId}`;
      default:
        return `${baseUrl}/${objType}s/${localId}`;
    }
  }

  return baseUrl;
}
