// /methods/feed/queryItems.js
// Unified query builder for FeedItems - works for both local and federation queries
import { FeedItems, Circle, Group } from "#schema";
import logger from "#methods/utils/logger.js";

/**
 * Query FeedItems with unified filtering logic for local and federation use
 *
 * @param {Object} options
 * @param {string[]} [options.members] - Server A user IDs to filter for (items visible to these users)
 * @param {string[]} [options.authors] - Author IDs - return PUBLIC items by these authors
 * @param {string[]} [options.groups] - Group IDs - return items addressed to these groups (if public or members present)
 * @param {string[]} [options.types] - Post types to filter by (Note, Article, etc.)
 * @param {string|Date} [options.since] - Return items published/updated after this timestamp
 * @param {number} [options.limit=50] - Max items to return
 * @param {string} [options.requestingDomain] - Domain making the request (for remote queries)
 * @returns {Promise<Object[]>} Array of FeedItems
 */
export default async function queryItems({
  members = [],
  authors = [],
  groups = [],
  types = [],
  since,
  limit = 50,
  requestingDomain,
} = {}) {
  // Normalize arrays
  const memberIds = Array.isArray(members) ? members : members ? [members] : [];
  const authorIds = Array.isArray(authors) ? authors : authors ? [authors] : [];
  const groupIds = Array.isArray(groups) ? groups : groups ? [groups] : [];
  const typeIds = Array.isArray(types) ? types : types ? [types] : [];

  // Build OR conditions
  const orConditions = [];

  // 1. Items addressed to Groups/Circles containing specified members
  if (memberIds.length > 0) {
    const memberCondition = await buildMemberVisibilityCondition(memberIds, requestingDomain);
    if (memberCondition) orConditions.push(memberCondition);
  }

  // 2. Public items by specified authors
  if (authorIds.length > 0) {
    orConditions.push({
      actorId: { $in: authorIds },
      to: "public",
    });
  }

  // 3. Items addressed to specified groups (if public or members present)
  if (groupIds.length > 0) {
    const groupCondition = await buildGroupCondition(groupIds, requestingDomain);
    if (groupCondition) orConditions.push(groupCondition);
  }

  // If no conditions, return empty
  if (orConditions.length === 0) {
    logger.warn("queryItems: No valid query conditions", { members, authors, groups });
    return [];
  }

  // Build final query
  const query = {
    $or: orConditions,
    tombstoned: { $ne: true }, // Exclude tombstoned items
  };

  // Add since filter
  if (since) {
    const sinceDate = since instanceof Date ? since : new Date(since);
    query.publishedAt = { $gte: sinceDate };
  }

  // Add types filter
  if (typeIds.length > 0) {
    query.type = { $in: typeIds };
  }

  // Execute query
  const items = await FeedItems.find(query)
    .sort({ publishedAt: -1 })
    .limit(Number(limit))
    .lean();

  logger.info("queryItems: Retrieved items", {
    count: items.length,
    filters: { members: memberIds.length, authors: authorIds.length, groups: groupIds.length },
  });

  return items;
}

/**
 * Build condition for items visible to specific members
 * Returns items addressed to Groups/Circles that contain these members
 */
async function buildMemberVisibilityCondition(memberIds, requestingDomain) {
  // Find all Groups where any of these members are in the members Circle
  const groups = await Group.find({ deletedAt: null })
    .select("id members")
    .lean();

  const groupsWithMembers = [];
  for (const group of groups) {
    if (!group.members) continue;

    const membersCircle = await Circle.findOne({ id: group.members })
      .select("members")
      .lean();

    if (!membersCircle?.members) continue;

    // Check if any requested member is in this group
    const hasRequestedMember = membersCircle.members.some(m =>
      memberIds.includes(m.id)
    );

    if (hasRequestedMember) {
      groupsWithMembers.push(group.id);
    }
  }

  // Build condition: items addressed to these groups
  if (groupsWithMembers.length === 0) return null;

  return { group: { $in: groupsWithMembers } };
}

/**
 * Build condition for items addressed to specific groups
 * Only returns items if group is public OR requesting domain has members
 */
async function buildGroupCondition(groupIds, requestingDomain) {
  const accessibleGroups = [];

  for (const groupId of groupIds) {
    const group = await Group.findOne({ id: groupId, deletedAt: null })
      .select("id members to rsvpPolicy")
      .lean();

    if (!group) continue;

    // Check if group is public (rsvpPolicy: "open")
    const isPublic = group.rsvpPolicy === "open";

    if (isPublic) {
      accessibleGroups.push(groupId);
      continue;
    }

    // If not public, check if requesting domain has members in this group
    if (requestingDomain && group.members) {
      const membersCircle = await Circle.findOne({ id: group.members })
        .select("members")
        .lean();

      if (membersCircle?.members) {
        const hasRemoteMembers = membersCircle.members.some(m =>
          m.id && m.id.endsWith(`@${requestingDomain}`)
        );

        if (hasRemoteMembers) {
          accessibleGroups.push(groupId);
        }
      }
    }
  }

  if (accessibleGroups.length === 0) return null;

  return { group: { $in: accessibleGroups } };
}
