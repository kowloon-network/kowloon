// /methods/core/getPost.js
// Get a post (local or remote) - works for Note, Article, Link, etc.

import getObjectById from "#methods/core/getObjectById.js";

/**
 * Get a post by ID
 * @param {string} id - Post ID (post:uuid@domain)
 * @param {Object} opts - Options
 * @param {string} opts.viewerId - Viewing user ID (for ACL)
 * @param {boolean} opts.allowRemote - Allow fetching from remote servers (default: true)
 * @param {number} opts.maxStaleSeconds - Use cached version if fresher than this (default: 300)
 * @returns {Promise<Object>} - post(id, server, type, title, summary, body, featuredImage, attachments, target, tags, location, startDate, endDate, parent, threadRoot, href, url)
 */
export default async function getPost(id, {
  viewerId = null,
  allowRemote = true,
  maxStaleSeconds = 300, // 5 minutes
} = {}) {
  const mode = allowRemote ? "prefer-local" : "local";

  const result = await getObjectById(id, {
    viewerId,
    mode,
    maxStaleSeconds,
    enforceLocalVisibility: true,
    hydrateRemoteIntoDB: true,
  });

  return result.object;
}
