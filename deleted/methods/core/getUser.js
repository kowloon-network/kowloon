// /methods/core/getUser.js
// Get a user profile (local or remote)

import getObjectById from "#methods/core/getObjectById.js";

/**
 * Get a user profile
 * @param {string} id - User ID (@username@domain)
 * @param {Object} opts - Options
 * @param {string} opts.viewerId - Viewing user ID (for ACL)
 * @param {boolean} opts.allowRemote - Allow fetching from remote servers (default: true)
 * @param {number} opts.maxStaleSeconds - Use cached version if fresher than this (default: 300)
 * @returns {Promise<Object>} - user(id, server, username, email, profile, prefs, circles, createdAt, updatedAt, publicKey, url)
 */
export default async function getUser(id, {
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
