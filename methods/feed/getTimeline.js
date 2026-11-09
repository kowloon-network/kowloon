// /methods/feed/getTimeline.js
// Timeline assembly via FeedFanOut lookup table

import mongoose from "mongoose";
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
async function updateMemberFetchedAt(circleId, circle, memberIds, at = new Date()) {
  // arrayFilters match members by id at write time. The old positional
  // `members.<idx>` used indexes from a snapshot read before a (slow) remote
  // pull -- if membership changed meanwhile, it stamped the wrong member.
  if (!memberIds?.length) return;
  await Circle.updateOne(
    { id: circleId },
    { $set: { "members.$[m].lastFetchedAt": at } },
    { arrayFilters: [{ "m.id": { $in: memberIds } }] }
  );
}

// Per-circle throttle for the background remote pull in getTimeline().
// In-memory and per-process (best effort); size-capped so it can't grow
// without bound -- Map iteration order is insertion order, so the first key
// is the oldest entry.
const CIRCLE_PULL_THROTTLE_MS = 5 * 60 * 1000;
const CIRCLE_PULL_MAX_ENTRIES = 10_000;
const lastCirclePull = new Map();

function shouldPullCircle(circleId) {
  const now = Date.now();
  const last = lastCirclePull.get(circleId);
  if (last && now - last < CIRCLE_PULL_THROTTLE_MS) return false;
  lastCirclePull.delete(circleId); // re-insert so it moves to the newest end
  lastCirclePull.set(circleId, now);
  while (lastCirclePull.size > CIRCLE_PULL_MAX_ENTRIES) {
    lastCirclePull.delete(lastCirclePull.keys().next().value);
  }
  return true;
}

/**
 * Pull remote members' posts for a circle (runs in the background).
 * The `to` list is ALL local users who have any of these remote members in any
 * circle -- not just the current viewer. This makes one pull populate FanOut for
 * every subscriber in a single round-trip, which is the correct model: the pull
 * is a server-level operation whose FanOut covers all local subscribers.
 */
async function pullCircleRemotes({ circleId, circle, viewerId, remoteMembersByDomain, limit }) {
  const Kowloon = (await import("#kowloon")).default;

  for (const [remoteDomain, remoteAuthors] of remoteMembersByDomain.entries()) {
    try {
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

      // Advance lastFetchedAt to the newest publishedAt actually received
      // (pullFromRemote pages through the window), not wall-clock now -- "now"
      // skipped anything past the first page. No items -> leave it unchanged
      // (a first-ever empty fetch retries a full pull next time).
      if (!result.error && result.newestPublishedAt) {
        await updateMemberFetchedAt(circleId, circle, remoteAuthors, result.newestPublishedAt);
      }
    } catch (err) {
      logger.warn("getTimeline: remote pull failed", { circleId, remoteDomain, error: err.message });
    }
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
 * @returns {Promise<{items: Array, nextCursor: string|null, total: null}>}
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
  // Fire-and-forget, first page only, throttled per circle. This used to be
  // awaited inline -- sequentially per remote domain, 30s timeout each, on
  // EVERY page -- so one slow peer stalled the whole circle feed. The
  // scheduled federation pull workers already keep FanOut fresh; this is just
  // a best-effort nudge so a freshly-opened circle catches up soon.
  if (!before && remoteMembersByDomain.size > 0 && shouldPullCircle(circleId)) {
    pullCircleRemotes({ circleId, circle, viewerId, remoteMembersByDomain, limit }).catch((err) =>
      logger.warn("getTimeline: background remote pull failed", { circleId, error: err.message })
    );
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

  // 7. Page through FeedFanOut newest-first (by fan-out createdAt), then load
  //    only the FeedItems for that window. Previously this loaded the viewer's
  //    ENTIRE FanOut history every page, $in-joined it to FeedItems and ran a
  //    countDocuments over all of it.
  //
  //    Cursor: "<createdAtISO>_<fanOutObjectId>" (opaque to the web client,
  //    which echoes nextCursor back as `before`). A plain ISO date is still
  //    accepted (legacy / mobile, which sends its oldest item's publishedAt)
  //    and is treated as a createdAt bound.
  const pageSize = Math.max(1, Number(limit) || 50);
  const batchSize = pageSize * 3;
  const MAX_BATCHES = 5; // bound work when filters (types/kinds/tombstones) reject most rows

  const itemFilter = {
    tombstoned: { $ne: true },
    objectType: { $nin: ["Group", "Circle"] },
  };
  if (types.length > 0) itemFilter.type = { $in: types };
  // ?kind=photo|video|audio|file (comma-separated) — e.g. ?types=Media&kind=photo
  // returns only posts with a photo attachment.
  if (kinds.length > 0) itemFilter["object.attachments.kind"] = { $in: kinds };

  let cursor = parseTimelineCursor(before);
  const picked = []; // FeedItems in FanOut order
  const seen = new Set();
  let lastRow = null;
  let exhausted = false;

  for (let batch = 0; batch < MAX_BATCHES && picked.length < pageSize; batch++) {
    const query = cursor
      ? { $and: [{ $or: fanOutOrConditions }, cursorCondition(cursor)] }
      : { $or: fanOutOrConditions };
    const rows = await FeedFanOut.find(query)
      .select("_id feedItemId createdAt")
      .sort({ createdAt: -1, _id: -1 })
      .limit(batchSize)
      .lean();
    if (rows.length < batchSize) exhausted = true;
    if (rows.length === 0) break;

    const ids = [...new Set(rows.map((r) => r.feedItemId).filter((id) => id && !seen.has(id)))];
    const docs = ids.length
      ? await FeedItems.find({ id: { $in: ids }, ...itemFilter }).lean()
      : [];
    const byId = new Map(docs.map((d) => [d.id, d]));

    for (const row of rows) {
      lastRow = row;
      const doc = byId.get(row.feedItemId);
      if (doc && !seen.has(doc.id)) {
        seen.add(doc.id);
        picked.push(doc);
        if (picked.length >= pageSize) break;
      }
    }
    cursor = { createdAt: lastRow.createdAt, oid: lastRow._id };
    if (exhausted) break;
  }

  // Stopped mid-batch because the page filled -> there is more. Stopped
  // because FanOut ran out -> end of feed. Hit MAX_BATCHES -> more may exist.
  const reachedEnd = exhausted && (picked.length < pageSize || lastRow === null);
  const nextCursor = !reachedEnd && lastRow
    ? `${new Date(lastRow.createdAt).toISOString()}_${lastRow._id}`
    : null;

  // Display order within the page is by publish time.
  const items = picked.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  logger.info("getTimeline: Retrieved items", { viewerId, circleId, count: items.length });

  // `total` is no longer computed (was a full countDocuments per page);
  // callers get null.
  return { items, nextCursor, total: null };
}

function parseTimelineCursor(before) {
  if (!before) return null;
  if (before instanceof Date) return isNaN(before) ? null : { createdAt: before, oid: null };
  const s = String(before);
  const m = s.match(/^(.+)_([0-9a-f]{24})$/i);
  const d = new Date(m ? m[1] : s);
  if (isNaN(d)) return null;
  return { createdAt: d, oid: m ? new mongoose.Types.ObjectId(m[2]) : null };
}

function cursorCondition({ createdAt, oid }) {
  if (!oid) return { createdAt: { $lt: createdAt } };
  // Tie-break on _id: bulk fan-out writes many rows in the same millisecond.
  return {
    $or: [
      { createdAt: { $lt: createdAt } },
      { createdAt, _id: { $lt: oid } },
    ],
  };
}
