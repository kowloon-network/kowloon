// /methods/feed/visibility.js
// Visibility and capability evaluators for FeedItems items
// Used by all GET endpoints to determine what viewers can see and do

import { Circle, Group, FeedFanOut, FeedItems, Post, Page, Bookmark, User } from "#schema";
import { getServerSettings } from "#methods/settings/schemaHelpers.js";
import logger from "#methods/utils/logger.js";
import { getViewerContext, getExclusionSets, domainOf } from "#methods/visibility/context.js";
import { canInteract } from "#methods/visibility/helpers.js";
import kowloonId from "#methods/parse/kowloonId.js";

const CAPABILITY_MODELS = { Post, Group, Bookmark, Page };

/**
 * Check if a viewer has an explicit FeedFanOut grant for an item.
 * This is the authoritative audience check for local "audience"-visibility items.
 * @param {string} feedItemId
 * @param {string} viewerId
 * @returns {Promise<boolean>}
 */
async function isInFanOutAudience(feedItemId, viewerId) {
  if (!feedItemId || !viewerId) return false;
  const entry = await FeedFanOut.findOne({ feedItemId, to: viewerId }).lean();
  return Boolean(entry);
}

/**
 * Is a group's content visible to this viewer? Mirrors the access rule in
 * routes/groups/posts.js: public group -> everyone; domain-scoped group
 * (@<domain>, or @server meaning the group's own domain) -> viewers on that
 * domain; otherwise -> members of the group's members Circle (members live in
 * Circle `group.circles.members`; Group has no top-level `members`).
 * Returns false when the Group isn't known locally (e.g. an uncached remote
 * group) so callers fall back to the FeedFanOut grant.
 */
export async function isGroupVisibleTo(groupId, viewerId) {
  if (!groupId) return false;
  const group = await Group.findOne({ id: groupId, deletedAt: null })
    .select("id to circles.members")
    .lean();
  if (!group) return false;

  const gTo = (group.to || "").toLowerCase().trim();
  if (gTo === "@public" || gTo === "public") return true;
  if (!viewerId) return false;

  const viewerDomain = domainOf(viewerId)?.toLowerCase();
  const groupDomain = kowloonId(group.id)?.domain?.toLowerCase();
  // Domain scope: "@server"/"server" = the group's own domain; "@<domain>"
  // (exactly one "@") = that domain.
  const scopeDomain =
    gTo === "@server" || gTo === "server"
      ? groupDomain
      : gTo.startsWith("@") && gTo.indexOf("@", 1) === -1
        ? gTo.slice(1)
        : null;
  if (scopeDomain && viewerDomain === scopeDomain) return true;

  if (group.circles?.members) {
    const isMember = await Circle.exists({
      id: group.circles.members,
      "members.id": viewerId,
    });
    if (isMember) return true;
  }
  return false;
}

/**
 * Check if viewer can see a FeedItems item
 * @param {Object} feedCacheItem - FeedItems document
 * @param {string|null} viewerId - Viewer's ID (null = anonymous)
 * @param {Object} [context] - Unused; kept for call-site compatibility
 * @returns {Promise<boolean>}
 */
export async function canView(feedCacheItem, viewerId, context = {}) { // eslint-disable-line no-unused-vars -- context kept for callers
  const { to } = feedCacheItem;

  // "public" → everyone can see
  if (to === "public" || to === "@public") {
    return true;
  }

  // "server" → local users only (or expose to all if you want)
  if (to === "server") {
    if (!viewerId) return false; // Anonymous can't see server-only
    const { domain } = getServerSettings();
    const isLocalViewer = viewerId
      ?.toLowerCase()
      .endsWith(`@${domain?.toLowerCase()}`);
    return isLocalViewer;
  }

  // "audience" → depends on origin
  if (to === "audience") {
    if (viewerId && feedCacheItem.actorId === viewerId) return true; // owner always sees own posts
    // Group-addressed items: writeFeedItems coarsens group:<id> to "audience",
    // but enqueueFanOut writes public/server groups as ONE @public/@server row
    // (never a per-viewer row), so the FanOut lookup below denied every
    // non-author member. Evaluate the group's own policy + live membership
    // instead (also lets members who joined after the post see it).
    if (feedCacheItem.group && (await isGroupVisibleTo(feedCacheItem.group, viewerId))) {
      return true;
    }
    if (!viewerId) return false;
    // FeedFanOut is authoritative for both local and remote audience posts
    // (remote group posts create per-user FeedFanOut records via enqueueFanOut)
    return isInFanOutAudience(feedCacheItem.id, viewerId);
  }

  return false;
}

// buildFollowerMap()/follows() and the "followers" capability were removed
// (2026-11-09): it scanned every User per call, read a nonexistent
// `u.following` field (always an empty Map), and nothing ever produces a
// "followers" capability -- Kowloon has no follow graph (circles replace it).

/**
 * Build membership map for circles/groups
 * @param {string[]} objectIds - Circle/Group IDs
 * @returns {Promise<Map<string, Set<string>>>}
 */
export async function buildMembershipMap(objectIds) {
  if (!objectIds || objectIds.length === 0) return new Map();

  const membershipMap = new Map();

  // Group by type
  const circleIds = objectIds.filter((id) => id.startsWith("circle:"));
  const groupIds = objectIds.filter((id) => id.startsWith("group:"));

  // Batch fetch
  const [circles, groups] = await Promise.all([
    circleIds.length > 0 ? Circle.find({ id: { $in: circleIds } }).lean() : [],
    groupIds.length > 0 ? Group.find({ id: { $in: groupIds } }).lean() : [],
  ]);

  // Build map
  for (const obj of [...circles, ...groups]) {
    const memberIds = (obj.members || []).map((m) => m.id).filter(Boolean);
    membershipMap.set(obj.id, new Set(memberIds));
  }

  return membershipMap;
}

/**
 * Check if viewer is in local audience
 * @param {string} viewerId - The viewer
 * @param {string[]} addressedIds - LOCAL circle/group IDs
 * @param {Map<string, Set<string>>} membershipMap - Pre-built membership map
 * @returns {boolean}
 */
export function inLocalAudience(viewerId, addressedIds, membershipMap) {
  if (!addressedIds || addressedIds.length === 0) return false;

  for (const id of addressedIds) {
    const members = membershipMap.get(id);
    if (members?.has(viewerId)) return true;
  }

  return false;
}

/**
 * Evaluate per-viewer capability (canReply/canReact)
 * @param {Object} opts
 * @param {string} opts.viewerId - The viewer
 * @param {string} opts.authorId - The author
 * @param {string} opts.capability - Capability value ("public"|"audience"|"none")
 * @param {string} opts.origin - Origin ("local"|"remote")
 * @param {string} opts.feedItemId - FeedItems.id (used for local audience check via FeedFanOut)
 * @param {string[]} opts.addressedIds - LOCAL addressed IDs (for local content)
 * @param {Object} opts.grants - Remote grants object (for remote content)
 * @param {Map} opts.membershipMap - Pre-built membership map
 * @returns {Promise<boolean>}
 */
export async function evaluateCapability({
  viewerId,
  authorId,
  capability,
  origin,
  feedItemId,
  addressedIds = [],
  grants = {},
  membershipMap,
}) {
  if (!capability || typeof capability !== "string") return false;

  const cap = capability.toLowerCase().trim();

  // "none" → always false
  if (cap === "none") return false;

  // Not logged in → false (even for "public" - must be authenticated to reply/react)
  if (!viewerId) return false;

  // "public" → true for any authenticated user
  if (cap === "public" || cap === "@public") return true;

  // "audience" → FeedFanOut is authoritative for both local and remote posts.
  // For local posts, try membership map first (avoids a DB query when addressedIds are available).
  if (cap === "audience") {
    if (origin !== "remote" && addressedIds.length > 0 && inLocalAudience(viewerId, addressedIds, membershipMap)) {
      return true;
    }
    return isInFanOutAudience(feedItemId, viewerId);
  }

  return false;
}

/**
 * Enrich FeedItems item with per-viewer capabilities
 * @param {Object} feedCacheItem - FeedItems document
 * @param {string|null} viewerId - Viewer's ID (null = anonymous)
 * @param {Object} context - Pre-loaded context { membershipMap, grants, addressedIds }
 * @returns {Promise<Object>} - Item with canReply/canReact booleans
 */
export async function enrichWithCapabilities(feedCacheItem, viewerId, context = {}) {
  const {
    membershipMap = new Map(),
    grants = {},
    addressedIds = [],
  } = context;

  const { id: feedItemId, actorId, origin, canReply, canReact } = feedCacheItem;

  const [canReplyBool, canReactBool] = await Promise.all([
    evaluateCapability({
      viewerId,
      authorId: actorId,
      capability: canReply,
      origin,
      feedItemId,
      addressedIds,
      grants,
      membershipMap,
    }),
    evaluateCapability({
      viewerId,
      authorId: actorId,
      capability: canReact,
      origin,
      feedItemId,
      addressedIds,
      grants,
      membershipMap,
    }),
  ]);

  return {
    ...feedCacheItem,
    canReply: canReplyBool,
    canReact: canReactBool,
  };
}

/**
 * Authorize an interaction (Reply/React) against an existing FeedItems
 * target. This is the single gate for ALL rejection reasons — target
 * missing, not visible to the actor, actor is blocked by the target's
 * author, or the relevant capability (canReply/canReact) is off.
 *
 * All but the capability case return an IDENTICAL generic 404: a requester
 * can't distinguish "blocked" from "not addressed to you" from "doesn't
 * exist". This is deliberate — Kowloon's relationship model is built on
 * ambiguity (circle membership is private, nobody gets an "unfollowed"
 * signal), and a distinguishing error for "you're blocked" would itself be a
 * disclosure the moment someone blocks you. The capability-disabled case is
 * NOT sensitive (the actor can already see the post; the author just turned
 * off replies/reactions) so it gets a real 403 + message, like X's "replies
 * are limited" state.
 *
 * The real reason is always logged server-side (structured, at info level)
 * so debugging "why didn't this go through" is never actually blind — the
 * ambiguity is purely client-facing.
 *
 * See kowloon-network/kowloon#40.
 *
 * @param {Object} opts
 * @param {string} opts.actorId - the user attempting to interact
 * @param {string} opts.targetId - the FeedItems id being replied to / reacted to
 * @param {"canReply"|"canReact"} [opts.capability] - omit to only check visibility+block
 * @returns {Promise<{ok:true}|{ok:false,status:number,message:string,reason:string}>}
 */
export async function authorizeInteraction({ actorId, targetId, capability }) {
  function deny(status, message, reason) {
    logger.info("Interaction denied", {
      reason,
      actorId,
      targetId,
      capability: capability || null,
    });
    return { ok: false, status, message, reason };
  }

  let feedCacheItem = await FeedItems.findOne({
    id: targetId,
    deletedAt: null,
    tombstoned: { $ne: true },
  }).lean();

  // Cold-miss on a remote target: this server has no prior relationship to
  // it (never pulled/federated in) — e.g. a visiting identity (see
  // routes/oauth/exchange.js, methods/oauth/proxyOutbox.js) interacting with
  // a post their home server has never seen. Fetch + cache it on demand
  // instead of 404ing, reusing the same machinery /resolve and /lookup
  // already use for exactly this. Local misses are NOT retried here — a
  // missing local object is genuinely missing.
  if (!feedCacheItem) {
    const { domain: localDomain } = getServerSettings();
    const parsed = kowloonId(targetId);
    const isRemote = parsed?.domain && parsed.domain.toLowerCase() !== localDomain?.toLowerCase();
    if (isRemote) {
      try {
        const [{ default: getObjectById }, { default: writeFeedItems }] = await Promise.all([
          import("#methods/core/getObjectById.js"),
          import("#methods/feed/writeFeedItems.js"),
        ]);
        const resolved = await getObjectById(targetId, {
          mode: "remote",
          hydrateRemoteIntoDB: true,
          enforceLocalVisibility: false,
        });
        if (resolved?.object) {
          await writeFeedItems(resolved.object, resolved.object.objectType || parsed.type);
        }
      } catch (err) {
        logger.info("On-demand remote resolve failed", { targetId, error: err.message });
      }
      feedCacheItem = await FeedItems.findOne({
        id: targetId,
        deletedAt: null,
        tombstoned: { $ne: true },
      }).lean();
    }
  }

  if (!feedCacheItem) return deny(404, "Not found", "not_found");

  const visible = await canView(feedCacheItem, actorId);
  if (!visible) return deny(404, "Not found", "not_visible");

  // Block: the target's author has blocked this actor — individually, or by
  // banning this actor's whole server. Skip when the actor IS the author
  // (can't block yourself out of your own content). Mute is deliberately
  // excluded here — mute only soft-hides on the read side, it never rejects
  // an interaction (see getExclusionSets).
  if (feedCacheItem.actorId && feedCacheItem.actorId !== actorId) {
    const { blockedActorIds, blockedDomains } = await getExclusionSets(feedCacheItem.actorId);
    const actorDomain = domainOf(actorId)?.toLowerCase();
    const isBlocked = blockedActorIds.has(actorId) || (actorDomain && blockedDomains.has(actorDomain));
    if (isBlocked) return deny(404, "Not found", "blocked");
  }

  if (capability) {
    // Read the RAW canReply/canReact value from the source model, not the
    // coarse FeedItems cache (enrichWithCapabilities/evaluateCapability) —
    // fan-out (enqueueFanOut.js) computes its rows entirely from `to` and
    // just stamps the raw canReply/canReact string onto every row verbatim,
    // so it has no mechanism to resolve a DIFFERENT audience (e.g. a post
    // public to everyone, but replies restricted to one circle). The cached
    // value can't represent that; the source Post's own field can. canReply/
    // canReact use the exact same to-shaped vocabulary as `to` itself
    // (@public / @<domain> / circle:<id> / group:<id> / @<user>@<domain> for
    // "only me") — evaluated the same way visibility is, via canInteract().
    const Model = CAPABILITY_MODELS[feedCacheItem.objectType];
    const raw = Model
      ? await Model.findOne({ id: targetId }).select(`${capability} actorId to`).lean()
      : null;
    // Empty canReply/canReact (the default) inherits the post's OWN raw `to`
    // — using raw.to here, not feedCacheItem.to, matters: FeedItems.to is
    // ALSO coarsened to public/server/audience by writeFeedItems.js, and
    // canInteract() needs the precise circle:/group:-prefixed value to
    // resolve real membership. Falling back to the coarse cache here would
    // incorrectly deny a circle's own members on any circle-scoped post with
    // no explicit canReply override.
    const capValue = raw?.[capability] || raw?.to;
    const ctx = await getViewerContext(actorId);
    // Remote posts (pulled via federation) never get a row in the local Post
    // collection — FeedItems.object is explicitly sanitized to drop to/
    // canReply/canReact (see schema/FeedItems.js), and the top-level
    // FeedItems.canReply/.canReact are the COARSE public/server/audience
    // tier, not the precise circle:/group:-scoped vocabulary canInteract()
    // needs — the same reason raw.to is used over the cache for local posts
    // above. So `raw` is always null for a remote post, `capValue` always
    // undefined, and canInteract(undefined, ...) always denies — every
    // remote-post react/reply was being rejected regardless of the actual
    // setting. We already know the actor can SEE this post (canView() passed
    // above); with no real capability data to check, default to allowing
    // rather than falsely denying.
    const allowed = raw ? canInteract(capValue, feedCacheItem.actorId, ctx) : true;
    if (!allowed) {
      const label = capability === "canReply" ? "Replies" : "Reactions";
      return deny(403, `${label} are disabled on this post.`, `${capability}_false`);
    }
  }

  return { ok: true };
}

/**
 * Build visibility filter for FeedItems queries
 * @param {string|null} viewerId - Viewer's ID (null = anonymous)
 * @returns {Object} - MongoDB filter
 */
export function buildVisibilityFilter(viewerId) {
  if (!viewerId) {
    // Anonymous: only public items
    return {
      to: { $in: ["public", "@public"] },
      deletedAt: null,
      tombstoned: { $ne: true },
    };
  }

  // Authenticated: public + server (if local).
  // "audience" items are authorized via FeedFanOut and are NOT included in this filter —
  // callers that need audience items should use getTimeline() (which queries FeedFanOut first)
  // or check canView() per-item.
  const { domain } = getServerSettings();
  const isLocalViewer = viewerId
    ?.toLowerCase()
    .endsWith(`@${domain?.toLowerCase()}`);

  const toFilter = isLocalViewer
    ? { $in: ["public", "@public", "server"] }
    : { $in: ["public", "@public"] };

  return {
    to: toFilter,
    deletedAt: null,
    tombstoned: { $ne: true },
  };
}

export default {
  canView,
  buildMembershipMap,
  inLocalAudience,
  evaluateCapability,
  enrichWithCapabilities,
  authorizeInteraction,
  buildVisibilityFilter,
};
