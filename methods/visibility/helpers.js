// /methods/visibility/helpers.js
import { domainOf } from "./context.js";
import { getServerSettings } from "#methods/settings/schemaHelpers.js";

const isCircleId = (s) => typeof s === "string" && s.startsWith("circle:");
const isGroupId = (s) => typeof s === "string" && s.startsWith("group:");
const isDomain = (s) =>
  typeof s === "string" && s.startsWith("@") && !["@public"].includes(s);

export function canInteract(to, actorId, ctx) {
  if (!ctx?.isAuthenticated) return false;
  if (actorId === ctx.viewerId) return true;

  if (to === "@public") return true;
  if (isDomain(to)) return to.slice(1) === ctx.viewerDomain; // @kwln.org
  if (isCircleId(to)) return ctx.circleIds.has(to);
  if (isGroupId(to)) return ctx.groupIds.has(to);
  return false;
}

export function sanitizeAudience(obj, ctx) {
  if (!obj) return obj;
  const out = { ...obj };
  const to = obj.to;

  if (to === "@public") out.visibility = "public";
  else if (isDomain(to)) out.visibility = "domain"; // keep exact token in `to`
  else if (isGroupId(to)) out.visibility = "group";
  else if (isCircleId(to)) {
    out.visibility = "circle";
    out.to = "@private";
  }

  out.canReply = canInteract(obj.canReply || to, obj.actorId, ctx);
  out.canReact = canInteract(obj.canReact || to, obj.actorId, ctx);
  return out;
}

// SECURITY: Replies and Reacts always have an empty `to` (visibility is
// inherited from the parent, see server CLAUDE.md), and the empty-`to` rule
// below made them visible to any authenticated viewer -- so a reply on a
// circle-only post could be read by anyone via /lookup or /resolve. Resolve
// them against their parent (target) instead.
const INTERACTION_TYPES = new Set(["Reply", "React"]);
const PARENT_LOOKUP_MAX_DEPTH = 3;

function interactionTypeOf(obj) {
  const t = obj?.objectType || obj?.type;
  if (INTERACTION_TYPES.has(t)) return t;
  if (typeof obj?.id === "string") {
    if (obj.id.startsWith("reply:")) return "Reply";
    if (obj.id.startsWith("react:")) return "React";
  }
  return null;
}

async function canSeeParent(obj, ctx, depth) {
  // Reply.target is the ROOT object of the thread; React.target is whatever
  // was reacted to (may itself be a Reply, handled by recursion).
  const targetId = obj.target;
  if (!targetId || typeof targetId !== "string" || depth > PARENT_LOOKUP_MAX_DEPTH) return false;

  const Models = await import("#schema");
  for (const name of ["Post", "Page", "Reply", "Circle", "Group", "Bookmark", "User"]) {
    const Model = Models[name];
    if (!Model) continue;
    const parent = await Model.findOne({ id: targetId }).lean();
    if (!parent) continue;
    if (parent.deletedAt) return false;
    if (!parent.objectType) parent.objectType = name;
    return canSeeObject(parent, ctx, depth + 1);
  }

  // Parent isn't a local object (e.g. a local reply on a remote post): use
  // the FeedItems cache + the same canView() GET /posts/:id uses.
  const { FeedItems } = Models;
  const item = FeedItems
    ? await FeedItems.findOne({ id: targetId, deletedAt: null, tombstoned: { $ne: true } }).lean()
    : null;
  if (!item) return false;
  const { canView, buildFollowerMap } = await import("#methods/feed/visibility.js");
  const followerMap = await buildFollowerMap([item.actorId]);
  return canView(item, ctx?.viewerId || null, { followerMap });
}

export async function canSeeObject(obj, ctx, _depth = 0) {
  if (!obj) return false;

  // User profiles are always findable when active. Personal-info fields
  // are gated at sanitize time based on the user's `to` audience — see
  // methods/sanitize/object.js. A deactivated/deleted user 404s.
  const objType = obj.objectType || obj.type;
  if (objType === "User" || objType === "Person") {
    if (obj.deletedAt) return false;
    if (obj.active === false) return false;
    return true;
  }

  // The object's owner can always see their own content
  if (ctx?.viewerId) {
    if (obj.actorId && obj.actorId === ctx.viewerId) return true;
    if (obj.id && obj.id === ctx.viewerId) return true; // User objects use id as the actor handle
  }

  if (interactionTypeOf(obj)) {
    return canSeeParent(obj, ctx, _depth);
  }

  const to = obj.to;

  // Empty/missing `to` defaults to server-wide visibility -- i.e. THIS
  // server's users. (SECURITY: previously any viewer with a domain, which
  // includes a remote actor authenticated by HTTP signature on /resolve.)
  if (!to || to === "") {
    const { domain } = getServerSettings();
    return !!(
      ctx?.isAuthenticated &&
      ctx.viewerDomain &&
      domain &&
      String(ctx.viewerDomain).toLowerCase() === String(domain).toLowerCase()
    );
  }

  // Public objects are always visible
  if (to === "@public") return true;

  // Domain-scoped: viewer must be from that domain
  if (isDomain(to)) {
    return !!(ctx?.viewerDomain && to.slice(1) === ctx.viewerDomain);
  }

  // Circle-scoped: viewer must be a member of that circle
  if (to?.startsWith("circle:")) {
    return !!ctx?.circleIds?.has?.(to);
  }

  // Group-scoped: check if viewer is a member OR if group is public
  if (to?.startsWith("group:")) {
    // First check if user is a member
    if (ctx?.groupIds?.has?.(to)) return true;

    // If not a member, check if group itself is public
    const { Group } = await import("#schema");
    const group = await Group.findOne({ id: to }).select("to").lean();
    if (!group) return false;

    // Group is visible if it's addressed to @public
    return group.to === "@public";
  }

  return false;
}
