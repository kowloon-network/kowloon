// #methods/visibility/context.js
import { Circle, Group, User } from "#schema";
import { escapeRegExp } from "./utils.js";
import { getBlockSets } from "#methods/moderation/blocklist.js";

export function domainOf(userId) {
  return typeof userId === "string" ? userId.split("@").pop() : undefined;
}

// Circle members are either a person ("@user@domain") or a whole server
// ("@domain", one @). Split a member list into the two so blocked/muted
// exclusion can cover "everyone on that server" as well as individuals.
function splitMembers(members) {
  const actorIds = new Set();
  const domains = new Set();
  for (const m of members ?? []) {
    const id = m?.id;
    if (typeof id !== "string" || !id) continue;
    if (/^@[^@]+$/.test(id)) domains.add(id.slice(1).toLowerCase());
    else actorIds.add(id);
  }
  return { actorIds, domains };
}

async function loadCircleMembers(circleId) {
  if (!circleId) return { actorIds: new Set(), domains: new Set() };
  const circle = await Circle.findOne({ id: circleId }).select("members.id").lean();
  return splitMembers(circle?.members);
}

// What the server's own lists hide from every reader
// (methods/moderation/federationPolicy.js): everything from a defederated
// server, and people on the server Blocked list -- except, for a member who
// keeps one of those people in their own circles, that person ("we don't
// control who our users read"). Read-side only, so it's folded into the
// muted sets: blocking an interaction is the inbox's job, not this.
async function serverHiddenSets(viewerId) {
  const { blockedActors, defederatedServers } = await getBlockSets();
  const actorIds = new Set(blockedActors);
  if (viewerId && actorIds.size) {
    const own = await Circle.find({ actorId: viewerId, deletedAt: null, "members.id": { $in: [...actorIds] } })
      .select("id members.id")
      .lean();
    const viewer = await User.findOne({ id: viewerId }).select("circles.blocked circles.muted").lean();
    const notReading = new Set([viewer?.circles?.blocked, viewer?.circles?.muted].filter(Boolean));
    for (const c of own) {
      if (notReading.has(c.id)) continue;
      for (const m of c.members || []) actorIds.delete(m.id);
    }
  }
  return { actorIds, domains: new Set(defederatedServers) };
}

// Blocked + muted actor ids and server domains for a viewer, kept separate
// (block = hard reject on interaction, mute = soft hide only — callers that
// need block-only semantics, like authorizeInteraction, must not union these).
// The server's own lists are added to the muted sets (see serverHiddenSets),
// for signed-out readers too.
export async function getExclusionSets(viewerId) {
  const hidden = await serverHiddenSets(viewerId);
  const empty = {
    blockedActorIds: new Set(),
    blockedDomains: new Set(),
    mutedActorIds: hidden.actorIds,
    mutedDomains: hidden.domains,
  };
  if (!viewerId) return empty;
  const viewer = await User.findOne({ id: viewerId }).select("circles.blocked circles.muted").lean();
  if (!viewer?.circles) return empty;
  const [blocked, muted] = await Promise.all([
    loadCircleMembers(viewer.circles.blocked),
    loadCircleMembers(viewer.circles.muted),
  ]);
  return {
    blockedActorIds: blocked.actorIds,
    blockedDomains: blocked.domains,
    mutedActorIds: new Set([...muted.actorIds, ...hidden.actorIds]),
    mutedDomains: new Set([...muted.domains, ...hidden.domains]),
  };
}

// A Mongo `$not`-able regex matching any actorId whose domain is in `domains`,
// or null if there's nothing to exclude. Kept separate from an id `$nin` list
// because a `$regex` (inclusion) and a domain-exclusion regex can't safely
// share one field-operator object — combine via `$and` of full field clauses.
export function domainExclusionRegex(domains) {
  if (!domains?.size) return null;
  const pattern = [...domains].map(escapeRegExp).join("|");
  return new RegExp(`@(${pattern})$`, "i");
}

// Apply an actorId exclusion (id set + optional domain regex) to a Mongo
// filter object in place. The one place this composition logic lives — every
// blocked/muted read-filter call site should go through this instead of
// hand-rolling its own $nin/$regex combination.
export function applyActorExclusion(filter, { ids = new Set(), domainRegex = null } = {}) {
  const clauses = [];
  if (ids.size) clauses.push({ actorId: { $nin: [...ids] } });
  if (domainRegex) clauses.push({ actorId: { $not: domainRegex } });
  if (!clauses.length) return filter;
  if (clauses.length === 1) return Object.assign(filter, clauses[0]);
  filter.$and = [...(filter.$and ?? []), ...clauses];
  return filter;
}

// Convenience one-shot for the common case: hide everything the viewer has
// blocked OR muted (individuals and whole servers) from a read-time filter.
export async function excludeBlockedMuted(filter, viewerId) {
  const { blockedActorIds, blockedDomains, mutedActorIds, mutedDomains } = await getExclusionSets(viewerId);
  const ids = new Set([...blockedActorIds, ...mutedActorIds]);
  ids.delete(viewerId);
  const domainRegex = domainExclusionRegex(new Set([...blockedDomains, ...mutedDomains]));
  return applyActorExclusion(filter, { ids, domainRegex });
}

export async function getViewerContext(viewerId) {
  if (!viewerId) {
    const hidden = await getExclusionSets(null);
    return {
      isAuthenticated: false,
      viewerId: null,
      viewerDomain: null,
      circleIds: new Set(),
      groupIds: new Set(),
      blockedActorIds: new Set(),
      blockedDomains: new Set(),
      mutedActorIds: hidden.mutedActorIds,
      mutedDomains: hidden.mutedDomains,
    };
  }

  const viewerDomain = domainOf(viewerId);

  const memberCircles = await Circle.find({
    "members.id": viewerId,
    deletedAt: null,
  })
    .select("id")
    .lean();
  const memberCircleIds = memberCircles.map((c) => c.id);

  // A Group's members-circle id lives at `circles.members` (there is no
  // top-level `members` field) — querying `members` matched nothing, so
  // groupIds was always empty and group-addressed posts fetched by id 403'd
  // even for members.
  const groups = memberCircleIds.length
    ? await Group.find({ "circles.members": { $in: memberCircleIds }, deletedAt: null })
        .select("id")
        .lean()
    : [];
  const groupIds = new Set(groups.map((g) => g.id));

  const exclusions = await getExclusionSets(viewerId);

  return {
    isAuthenticated: true,
    viewerId,
    viewerDomain,
    circleIds: new Set(memberCircleIds),
    groupIds,
    blockedActorIds: exclusions.blockedActorIds,
    blockedDomains: exclusions.blockedDomains,
    mutedActorIds: exclusions.mutedActorIds,
    mutedDomains: exclusions.mutedDomains,
  };
}
