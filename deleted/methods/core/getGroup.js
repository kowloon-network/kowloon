// /methods/core/getGroup.js
// Get a Group (if visible to current user)

import getObjectById from "#methods/core/getObjectById.js";

/**
 * Get a Group
 * @param {string} id - Group ID (group:uuid@domain)
 * @param {Object} opts - Options
 * @param {string} opts.viewerId - Viewing user ID (for ACL)
 * @param {boolean} opts.allowRemote - Allow fetching from remote servers (default: true)
 * @param {number} opts.maxStaleSeconds - Use cached version if fresher than this (default: 300)
 * @returns {Promise<Object>} - group(id, server, name, summary, admins, moderators, members, to, rsvpPolicy, location, createdAt, updatedAt, url)
 */
export default async function getGroup(id, {
  viewerId = null,
  allowRemote = true,
  maxStaleSeconds = 300,
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
