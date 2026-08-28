// routes/users/posts.js
// GET /users/:id/posts — Posts by a user, visibility-filtered by viewer relationship.
//
// Queries FeedItems (not Post) for consistent visibility handling.
// Circle-addressed posts (to:"audience") are only returned when the viewer IS the author.

import route from "../utils/route.js";
import { FeedItems } from "#schema";
import { activityStreamsCollection } from "../utils/oc.js";
import feedItemToPost from "#methods/feed/feedItemToPost.js";
import { enrichAttachments } from "#methods/files/enrichAttachments.js";
import { getSetting } from "#methods/settings/cache.js";
import isLocalDomain from "#methods/parse/isLocalDomain.js";
import kowloonId from "#methods/parse/kowloonId.js";

export default route(async ({ req, params, query, user, set }) => {
  const userId = decodeURIComponent(params.id);
  const domain = getSetting("domain");

  // Determine viewer relationship
  let isLocal = false;
  const isOwn = user?.id === userId;
  if (user?.id) {
    const parsed = kowloonId(user.id);
    isLocal = parsed.domain && isLocalDomain(parsed.domain);
  }

  // Build visibility filter
  let toFilter;
  if (isOwn) {
    // Author sees all their own posts (public, server, audience/circle)
    toFilter = { $in: ["public", "server", "audience"] };
  } else if (!user?.id) {
    // Unauthenticated: public only
    toFilter = "public";
  } else if (isLocal) {
    // Local auth'd user: public + server
    toFilter = { $in: ["public", "server"] };
  } else {
    // Remote user: public only
    toFilter = "public";
  }

  const filter = {
    actorId: userId,
    to: toFilter,
    tombstoned: { $ne: true },
    objectType: "Post",
  };

  if (query.type)  filter.type        = query.type;
  // ?kind=photo|video|audio|file (comma-separated) — e.g. ?type=Media&kind=photo
  // returns only posts with a photo attachment. Backed by the
  // {objectType,type,"object.attachments.kind"} FeedItems index.
  const kinds = query.kind
    ? String(query.kind).split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  if (kinds?.length) {
    filter["object.attachments.kind"] = { $in: kinds };
  }
  if (query.since) filter.publishedAt = { $gte: new Date(query.since) };

  const page  = Math.max(1, parseInt(query.page,  10) || 1);
  const limit = Math.min(Math.max(1, parseInt(query.limit, 10) || 20), 100);
  const skip  = (page - 1) * limit;

  // sort=top ranks by engagement (for the "More Posts" strip on post pages);
  // default is reverse-chronological.
  const sortSpec =
    query.sort === "top"
      ? { "object.reactCount": -1, publishedAt: -1 }
      : { publishedAt: -1 };

  const [docs, total] = await Promise.all([
    FeedItems.find(filter).sort(sortSpec).skip(skip).limit(limit).lean(),
    FeedItems.countDocuments(filter),
  ]);

  const items = docs.map((doc) => {
    const item = feedItemToPost(doc);
    // When filtering by kind, only show the matching attachment(s) — "show
    // just the photos", not the photo plus whatever else is on the post.
    if (kinds?.length && item.attachments?.length) {
      item.attachments = item.attachments.filter((a) => kinds.includes(a?.kind));
    }
    return item;
  });

  const protocol = req.headers["x-forwarded-proto"] || "https";
  // Resolve file:/proxy-URL image + attachments to client URLs + mediaType, so
  // My Posts renders media the same as the Community/circle feeds (#49).
  await enrichAttachments(items, { protocol });
  const base     = `${protocol}://${domain}/users/${encodeURIComponent(userId)}/posts`;

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
