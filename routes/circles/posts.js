// routes/circles/posts.js
// GET /circles/:id/posts — Primary timeline view (circle-based feed)

import route from "../utils/route.js";
import { Circle } from "#schema";
import getTimeline from "#methods/feed/getTimeline.js";
import { getSetting } from "#methods/settings/cache.js";
import { enrichAttachments } from "#methods/files/enrichAttachments.js";

const VISIBILITY_MAP = { public: 'Public', server: 'Server', audience: 'Audience' };

function parseUsername(actorId) {
  if (!actorId) return null;
  return actorId.replace(/^@/, '').split('@')[0] || null;
}

function normalizeFeedItem(item) {
  const raw = item.toObject ? item.toObject() : { ...item };
  const obj = raw.object ?? {};
  const actor = (obj.actor && Object.keys(obj.actor).length > 0) ? obj.actor : null;

  return {
    ...obj,
    id: raw.id,
    url: raw.url ?? obj.url,
    objectType: raw.objectType,
    type: raw.type,
    attributedTo: {
      id: raw.actorId,
      name: actor?.name ?? parseUsername(raw.actorId),
      icon: actor?.icon ?? null,
      url: actor?.url ?? null,
      server: actor?.server ?? null,
    },
    published: raw.publishedAt,
    publishedAt: raw.publishedAt,
    visibility: VISIBILITY_MAP[raw.to] ?? 'Public',
    canReply: raw.canReply,
    canReact: raw.canReact,
    startTime: raw.type === 'Event' ? (obj.event?.startDate ?? null) : undefined,
    endTime:   raw.type === 'Event' ? (obj.event?.endDate   ?? null) : undefined,
  };
}

export default route(async ({ req, params, query, user, set, setStatus }) => {
  const circleId = decodeURIComponent(params.id);

  // A circle's feed is viewable by anyone allowed to see the circle — not just
  // its owner. getTimeline is viewer-scoped (FeedFanOut only surfaces posts the
  // viewer may see), so a public circle previews safely: you see its members'
  // posts that are visible to you.
  const circle = await Circle.findOne({ id: circleId, deletedAt: null })
    .select("actorId to members")
    .lean();

  if (!circle) {
    setStatus(404);
    set("error", "Not found");
    return;
  }

  const domain = getSetting("domain");
  const to = circle.to || "";
  const isPublic = to === "@public" || to === "public";
  const isServerVisible =
    to === `@${domain}` || to === "@server" || to === "server";
  const isOwner = !!user?.id && circle.actorId === user.id;
  const isMember = !!user?.id && circle.members?.some((m) => m.id === user.id);

  if (!user?.id) {
    setStatus(401);
    set("error", "Authentication required");
    return;
  }
  if (!isPublic && !isServerVisible && !isOwner && !isMember) {
    setStatus(403);
    set("error", "Access denied");
    return;
  }

  const types = query.types
    ? String(query.types).split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const before = query.before || null;
  const limit = Math.min(Number(query.limit) || 50, 500);

  const result = await getTimeline({ viewerId: user.id, circleId, types, before, limit });
  const normalized = result.items.map(normalizeFeedItem);

  // Resolve `image`/`attachments` via the shared enrichment transform. Items
  // only carry `visibility` (Public/Server/Audience), not a raw `to` — build
  // a throwaway parallel array so `to` never leaks into the actual response.
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const enrichTargets = normalized.map((item) => ({
    image: item.image,
    attachments: item.attachments,
    to: item.visibility === "Public" ? "public" : "server",
  }));
  await enrichAttachments(enrichTargets, { protocol });

  const orderedItems = normalized.map((item, i) => {
    item.featuredImage = enrichTargets[i].featuredImage ?? null;
    item.attachments = enrichTargets[i].attachments ?? [];
    return item;
  });

  const baseUrl = `${protocol}://${domain}/circles/${encodeURIComponent(circleId)}/posts`;

  set("@context", "https://www.w3.org/ns/activitystreams");
  set("type", "OrderedCollectionPage");
  set("id", req.originalUrl ? `${protocol}://${domain}${req.originalUrl}` : baseUrl);
  set("partOf", baseUrl);
  set("totalItems", result.total);
  set("orderedItems", orderedItems);
  if (result.nextCursor) {
    set("nextCursor", result.nextCursor);
    set("next", `${baseUrl}?before=${encodeURIComponent(result.nextCursor)}`);
  }
});
