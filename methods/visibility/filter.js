import { escapeRegExp } from "./utils.js";
import { applyActorExclusion, domainExclusionRegex } from "./context.js";

export function buildVisibilityQuery(ctx) {
  const base = { deletedAt: null };

  if (!ctx?.isAuthenticated) {
    // Signed-out readers still don't see what the server's lists hide.
    const filter = { ...base, to: "@public" };
    applyActorExclusion(filter, {
      ids: new Set(ctx?.mutedActorIds ?? []),
      domainRegex: domainExclusionRegex(new Set(ctx?.mutedDomains ?? [])),
    });
    return filter;
  }

  const or = [];

  // own
  or.push({ actorId: ctx.viewerId });

  // public
  or.push({ to: "@public" });

  if (ctx.viewerDomain) {
    // NEW: explicit domain token
    or.push({ to: `@${ctx.viewerDomain}` });

    // LEGACY: old '@server' docs scoped by actorId domain
    or.push({
      to: "@server",
      actorId: new RegExp(`@${escapeRegExp(ctx.viewerDomain)}$`),
    });
  }

  if (ctx.circleIds.size) or.push({ to: { $in: [...ctx.circleIds] } });
  if (ctx.groupIds.size) or.push({ to: { $in: [...ctx.groupIds] } });

  const filter = { ...base, $or: or };

  // Hide anything from a blocked or muted actor OR whole server (mute is
  // soft-hide-only, but it shares the same "keep this out of my view"
  // semantics as block's read-side effect here).
  const ids = new Set([...ctx.blockedActorIds, ...(ctx.mutedActorIds ?? [])]);
  ids.delete(ctx.viewerId);
  const domainRegex = domainExclusionRegex(new Set([...ctx.blockedDomains ?? [], ...(ctx.mutedDomains ?? [])]));
  applyActorExclusion(filter, { ids, domainRegex });

  return filter;
}
