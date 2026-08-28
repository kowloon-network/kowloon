// /methods/feed/getTimeline.js
// Timeline assembly via FeedFanOut lookup table

import { FeedItems, FeedFanOut, Circle, User } from "#schema";
import logger from "#methods/utils/logger.js";
import { getServerSettings } from "#methods/settings/schemaHelpers.js";
import { getExclusionSets, domainExclusionRegex } from "#methods/visibility/context.js";

function extractDomain(str) {
  if (!str) return null;
  try {
    const url = new URL(str);
    return url.hostname;
  } catch {
    const parts = str.split("@").filter(Boolean);
    return parts[parts.length - 1];
  }
}

async function getUserGroups(viewerId) {
  const user = await User.findOne({ id: viewerId }).select("circles").lean();
  if (!user) return [];

  const groups = [];

  if (user.circles?.groups) {
    const groupsCircle = await Circle.findOne({ id: user.circles.groups }).select("members").lean();
    if (groupsCircle?.members) {
      groups.push(...groupsCircle.members.map((m) => m.id).filter((id) => id?.startsWith("group:")));
    }
  }

  return groups;
}

/**
 * Find every local user (actorId) who has any of the given remote member IDs in
 * any of their circles. Used to build the `to` list for a batch pull so that one
 * pull fans out to ALL subscribers, not just the requesting viewer.
 */
async function findAllCircleSubscribers(remoteAuthorIds) {
  const circles = await Circle.find({
    "members.id": { $in: remoteAuthorIds },
  }).select("actorId").lean();

  return [
    ...new Set(
      circles
        .map((c) => c.actorId)
        .filter((id) => id && id.startsWith("@") && id.slice(1).includes("@"))
    ),
  ];
}

/**
 * Compute the oldest lastFetchedAt across a set of member IDs within a circle.
 * Returns null if any member has never been fetched (forces full fetch).
 */
function oldestFetchedAt(circle, memberIds) {
  let oldest = new Date(); // start with now
  for (const memberId of memberIds) {
    const member = circle.members.find((m) => m.id === memberId);
    if (!member?.lastFetchedAt) return null; // never fetched — pull everything
    const t = new Date(member.lastFetchedAt);
    if (t < oldest) oldest = t;
  }
  return oldest;
}

/**
 * Update lastFetchedAt for a set of remote members in a circle.
 */
async function updateMemberFetchedAt(circleId, circle, memberIds) {
  const now = new Date();
  const setFields = {};
  for (const memberId of memberIds) {
    const idx = circle.members.findIndex((m) => m.id === memberId);
    if (idx !== -1) {
      setFields[`members.${idx}.lastFetchedAt`] = now;
    }
  }
  if (Object.keys(setFields).length > 0) {
    await Circle.updateOne({ id: circleId }, { $set: setFields });
  }
}

/**
 * Assemble timeline for a user from a specific Circle
 *
 * @param {Object} options
 * @param {string} options.viewerId - Required: user requesting timeline
 * @param {string} options.circleId - Required: Circle to view timeline for
 * @param {string[]} [options.types=[]] - Filter by post types (Note, Article, etc.)
 * @param {string[]} [options.kinds=[]] - Filter by attachment kind (photo, video, audio, file)
 * @param {string|Date} [options.before=null] - Pagination cursor: return items older than this date
 * @param {number} [options.limit=50] - Max results
 *
 * @returns {Promise<{items: Array, nextCursor: string|null, total: number}>}
 */
export default async function getTimeline({
  viewerId,
  circleId,
  types = [],
  kinds = [],
  before = null,
  limit = 50,
} = {}) {
  if (!viewerId) throw new Error("getTimeline requires viewerId");
  if (!circleId) throw new Error("getTimeline requires circleId");

  const { domain: ourDomain } = getServerSettings();

  logger.info("getTimeline: Request", { viewerId, circleId, types: types.length, kinds: kinds.length, before, limit });

  // 1. Get circle (with members including lastFetchedAt)
  const circle = await Circle.findOne({ id: circleId }).lean();
  if (!circle) {
    logger.warn("getTimeline: Circle not found", { circleId });
    return { items: [], nextCursor: null, total: 0 };
  }

  // Include the viewer's own posts only when they are a MEMBER of this circle —
  // NOT merely its owner. A circle is the set of people whose posts you want to
  // read; owning a circle of other people shouldn't inject your own posts into
  // it. (The Following circle adds the user to itself at registration, so it
  // still reads like a home feed.) Members are the authoritative set either way.
  const memberSet = new Set(circle.members?.map((m) => m.id).filter(Boolean) ?? []);
  const viewerBelongs = (circle.members ?? []).some((m) => m.id === viewerId);
  if (viewerBelongs) memberSet.add(viewerId);
  const allMembers = Array.from(memberSet);

  // 2. Separate local vs remote members
  const localMembers = [];
  const remoteMembersByDomain = new Map();

  for (const memberId of allMembers) {
    const memberDomain = extractDomain(memberId);
    if (memberDomain === ourDomain) {
      localMembers.push(memberId);
    } else {
      if (!remoteMembersByDomain.has(memberDomain)) {
        remoteMembersByDomain.set(memberDomain, []);
      }
      remoteMembersByDomain.get(memberDomain).push(memberId);
    }
  }

  // 3. Get viewer's groups
  const groups = await getUserGroups(viewerId);
  const localGroups = groups.filter((g) => extractDomain(g) === ourDomain);
  const remoteGroupsByDomain = new Map();

  groups.filter((g) => extractDomain(g) !== ourDomain).forEach((g) => {
    const domain = extractDomain(g);
    if (!remoteGroupsByDomain.has(domain)) remoteGroupsByDomain.set(domain, []);
    remoteGroupsByDomain.get(domain).push(g);
  });

  // 4. Pull from remote servers (on-demand, cursor-based).
  //
  // The `to` list is ALL local users who have any of these remote members in any
  // circle — not just the current viewer. This makes one pull populate FanOut for
  // every subscriber in a single round-trip, which is the correct model: the pull
  // is a server-level operation whose FanOut covers all local subscribers.
  const Kowloon = (await import("#kowloon")).default;

  for (const [remoteDomain, remoteAuthors] of remoteMembersByDomain.entries()) {
    const pullSince = oldestFetchedAt(circle, remoteAuthors);

    // Find everyone on this server who follows any of these remote members.
    const allSubscribers = await findAllCircleSubscribers(remoteAuthors);
    const pullTo = allSubscribers.length > 0 ? allSubscribers : [viewerId];

    const result = await Kowloon.federation.pullFromRemote({
      remoteDomain,
      from: remoteAuthors,
      to: pullTo,
      since: pullSince,
      limit,
    });

    // Update lastFetchedAt on success, but only if this was an incremental
    // pull (pullSince was set) or we actually got items back. If this was a
    // first-ever fetch (pullSince=null) and returned 0 items, don't mark it
    // as fetched — the remote may have had a temporary bug and we want to
    // retry the full pull next time rather than locking into an empty window.
    if (!result.error) {
      const gotItems = (result.items?.length ?? 0) > 0;
      const wasIncremental = pullSince !== null;
      if (gotItems || wasIncremental) {
        await updateMemberFetchedAt(circleId, circle, remoteAuthors);
      }
    }
  }

  // 5. Get blocked/muted users
  const { blockedActorIds, blockedDomains, mutedActorIds, mutedDomains } = await getExclusionSets(viewerId);
  const excludedIds = new Set([...blockedActorIds, ...mutedActorIds]);
  excludedIds.delete(viewerId);
  const excludedDomainRegex = domainExclusionRegex(new Set([...blockedDomains, ...mutedDomains]));

  // Bare server entries in this circle (e.g. "@kwln2.local") are public-firehose
  // subscriptions. Their FanOut rows are created per-subscriber by pullFromRemote
  // (to: specificUserId). We add a server-domain regex condition to find them.
  const serverMemberDomains = (circle.members ?? [])
    .map((m) => m.id)
    .filter((id) => typeof id === "string" && id.startsWith("@") && !id.slice(1).includes("@"))
    .map((id) => id.slice(1));

  // 6. Query FeedFanOut for feed item IDs visible to this viewer.
  //
  // Two `to` patterns coexist in the FanOut table:
  //   - Local public/server posts: ONE row with to="@public" or to="@server" (enqueueFeedFanOut)
  //   - Remote/circle posts: per-user rows with to=specificUserId (pullFromRemote / circle fan-out)
  // The `to` filter must cover all three values.
  //
  // actorId filter: only authors who are members of THIS circle should appear.
  // Server-domain members use a domain-regex instead of exact match.

  const toFilter = { $in: ["@public", "@server", viewerId] };

  // Exclude server-entry IDs from the $in list — they never appear as actorId on real posts.
  const nonServerMembers = allMembers.filter(
    (id) => !(typeof id === "string" && id.startsWith("@") && !id.slice(1).includes("@"))
  );

  // actorId exclusion (blocked/muted individuals + whole servers) can't safely
  // share one field-operator object with the $in/$regex inclusion above, so
  // each branch is composed as an $and of independent field clauses.
  const userActorConds = [{ actorId: { $in: nonServerMembers } }, { to: toFilter }];
  if (excludedIds.size) userActorConds.push({ actorId: { $nin: [...excludedIds] } });
  if (excludedDomainRegex) userActorConds.push({ actorId: { $not: excludedDomainRegex } });

  const fanOutOrConditions = [{ $and: userActorConds }];

  if (serverMemberDomains.length > 0) {
    const escaped = serverMemberDomains.map((d) => d.replace(/[.\\+*?^${}()|[\]]/g, "\\$&"));
    const regexStr = `@[^@]+@(${escaped.join("|")})$`;
    // Server-domain FanOut rows always have to=specificUserId (created by pullFromRemote),
    // so viewerId in the toFilter covers them.
    const serverActorConds = [{ actorId: { $regex: regexStr } }, { to: toFilter }];
    if (excludedIds.size) serverActorConds.push({ actorId: { $nin: [...excludedIds] } });
    if (excludedDomainRegex) serverActorConds.push({ actorId: { $not: excludedDomainRegex } });
    fanOutOrConditions.push({ $and: serverActorConds });
  }

  if (localGroups.length > 0) {
    fanOutOrConditions.push({
      groupId: { $in: localGroups },
      to: toFilter,
    });
  }

  const fanOutDocs = await FeedFanOut.find({ $or: fanOutOrConditions })
    .select("feedItemId")
    .lean();

  const feedItemIds = [...new Set(fanOutDocs.map((f) => f.feedItemId).filter(Boolean))];

  if (feedItemIds.length === 0) {
    logger.info("getTimeline: No FeedFanOut records found", { viewerId, circleId });
    return { items: [], nextCursor: null, total: 0 };
  }

  // 7. Query FeedItems by IDs with optional filters
  const baseQuery = {
    id: { $in: feedItemIds },
    tombstoned: { $ne: true },
    objectType: { $nin: ["Group", "Circle"] },
  };

  if (types.length > 0) {
    baseQuery.type = { $in: types };
  }

  // ?kind=photo|video|audio|file (comma-separated) — e.g. ?types=Media&kind=photo
  // returns only posts with a photo attachment. Same treatment as `types`
  // above: applied to baseQuery so it flows into both pageQuery (spread below)
  // and the count query.
  if (kinds.length > 0) {
    baseQuery["object.attachments.kind"] = { $in: kinds };
  }

  // Pagination: items older than `before` cursor (newest-first feed, scroll backward in time)
  const pageQuery = { ...baseQuery };
  if (before) {
    const beforeDate = before instanceof Date ? before : new Date(before);
    pageQuery.publishedAt = { $lt: beforeDate };
  }

  const [items, total] = await Promise.all([
    FeedItems.find(pageQuery)
      .sort({ publishedAt: -1 })
      .limit(Number(limit))
      .lean(),
    FeedItems.countDocuments(baseQuery),
  ]);

  logger.info("getTimeline: Retrieved items", { viewerId, circleId, count: items.length, total });

  // nextCursor is null when we got fewer items than the limit (end of feed reached)
  const nextCursor = items.length === Number(limit)
    ? new Date(items[items.length - 1].publishedAt).toISOString()
    : null;

  return { items, nextCursor, total };
}
