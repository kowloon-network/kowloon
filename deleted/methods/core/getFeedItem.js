// /methods/core/getFeedItem.js
// Get a FeedItem (rendered, sanitized version for end users)

import { FeedItems } from "#schema";
import { canView } from "#methods/feed/visibility.js";

/**
 * Get a FeedItem by ID, enforcing visibility for the given viewer.
 * Returns null if not found or if the viewer is not allowed to see it.
 * @param {string} id - FeedItem ID
 * @param {Object} opts
 * @param {string|null} opts.viewerId - Viewing user ID (null = anonymous)
 * @returns {Promise<Object|null>}
 */
export default async function getFeedItem(id, { viewerId = null } = {}) {
  if (!id) throw new Error("getFeedItem requires id");

  const item = await FeedItems.findOne({
    id,
    tombstoned: { $ne: true },
  }).lean();

  if (!item) return null;

  const allowed = await canView(item, viewerId);
  if (!allowed) return null;

  return item;
}
