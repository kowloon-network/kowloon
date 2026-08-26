// routes/posts/collection.js
// GET /posts — Public firehose.
//
// Visibility:
//   - Unauthenticated / remote users → @public posts only
//   - Authenticated local users      → @public + @server posts
//
// Queries FeedItems (not Post directly) so federated posts and visibility tiers
// are handled consistently across the whole application.

import route from "../utils/route.js";
import { activityStreamsCollection } from "../utils/oc.js";
import { FeedItems, React as ReactModel } from "#schema";
import feedItemToPost from "#methods/feed/feedItemToPost.js";
import { getSetting } from "#methods/settings/cache.js";
import isLocalDomain from "#methods/parse/isLocalDomain.js";
import kowloonId from "#methods/parse/kowloonId.js";
import { enrichAttachments } from "#methods/files/enrichAttachments.js";
import { excludeBlockedMuted } from "#methods/visibility/context.js";

export default route(async ({ req, query, user, set, setStatus }) => {
  // Determine visibility tiers for this viewer
  let isLocal = false;
  if (user?.id) {
    const parsed = kowloonId(user.id);
    isLocal = parsed.domain && isLocalDomain(parsed.domain);
  }

  // Optional ?to=public|server restricts the visibility tier — used by mobile
  // and other clients to request explicit firehoses. Omitted = the default
  // merged view (public + server for authed local users; public only otherwise).
  const toFilter = query.to ? String(query.to).toLowerCase() : null;
  if (toFilter === "server" && !isLocal) {
    setStatus(403);
    set("error", "Server-only posts are restricted to authenticated local users");
    return;
  }

  const visibilityFilter =
    toFilter === "public"
      ? "public"
      : toFilter === "server"
      ? "server"
      : isLocal
      ? { $in: ["public", "server"] }
      : "public";

  const filter = {
    to: visibilityFilter,
    tombstoned: { $ne: true },
    objectType: "Post",
  };

  if (query.type) {
    const types = String(query.type).split(",").map((s) => s.trim()).filter(Boolean);
    filter.type = types.length > 1 ? { $in: types } : types[0];
  }
  // ?kind=photo|video|audio|file (comma-separated) — e.g. ?type=Media&kind=photo
  // returns only posts with a photo attachment. Backed by the
  // {objectType,type,"object.attachments.kind"} FeedItems index.
  const kinds = query.kind
    ? String(query.kind).split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  if (kinds?.length) {
    filter["object.attachments.kind"] = { $in: kinds };
  }
  if (query.since)    filter.publishedAt = { $gte: new Date(query.since) };
  if (query.serverId) {
    filter.server = query.serverId;
  } else {
    // Community Posts = the viewer's OWN server only. Firehose posts pulled from
    // other servers (into a Circle) keep their source originDomain, so without
    // this they leak into Community (#64). Match own-domain items; tolerate
    // legacy rows that predate originDomain (null) as local.
    const localDomain = getSetting("domain");
    if (localDomain) filter.originDomain = { $in: [localDomain, null] };
  }

  // Hide posts from anyone (or any whole server) the viewer has blocked/muted.
  await excludeBlockedMuted(filter, user?.id);

  const page  = Math.max(1, parseInt(query.page,  10) || 1);
  const limit = Math.min(Math.max(1, parseInt(query.limit, 10) || 20), 100);
  const skip  = (page - 1) * limit;

  const [docs, total] = await Promise.all([
    FeedItems.find(filter).sort({ publishedAt: -1 }).skip(skip).limit(limit).lean(),
    FeedItems.countDocuments(filter),
  ]);

  // The viewer's own reaction per post (for the react button state on cards).
  let myReactByTarget = new Map();
  if (user?.id && docs.length) {
    const targetIds = docs
      .map((d) => d?.object?.id || d?.id)
      .filter(Boolean);
    const mine = await ReactModel.find({
      actorId: user.id,
      target: { $in: targetIds },
    })
      .select("target emoji")
      .lean();
    myReactByTarget = new Map(mine.map((r) => [r.target, r.emoji]));
  }

  const items = docs.map((doc) => {
    const item = feedItemToPost(doc);
    item.myReact = myReactByTarget.get(item.id) ?? null;
    // When filtering by kind, only show the matching attachment(s) — "show
    // just the photos", not the photo plus whatever else is on the post.
    if (kinds?.length && item.attachments?.length) {
      item.attachments = item.attachments.filter((a) => kinds.includes(a?.kind));
    }
    return item;
  });

  const domain   = getSetting("domain");
  const protocol = req.headers["x-forwarded-proto"] || "https";

  await enrichAttachments(items, { protocol });

  const base     = `${protocol}://${domain}${req.baseUrl}`;

  const collection = activityStreamsCollection({
    id: `${base}?page=${page}`,
    orderedItems: items,
    totalItems: total,
    page,
    itemsPerPage: limit,
    baseUrl: base,
  });

  for (const [key, value] of Object.entries(collection)) {
    set(key, value);
  }
});
