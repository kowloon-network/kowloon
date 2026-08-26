import route from "../utils/route.js";
import { FeedItems, Post, React as ReactModel } from "#schema";
import {
  canView,
  buildFollowerMap,
  enrichWithCapabilities,
} from "#methods/feed/visibility.js";
import { enrichAttachments } from "#methods/files/enrichAttachments.js";

const VISIBILITY_MAP = { public: "Public", server: "Server", audience: "Audience" };

export default route(async ({ req, params, set, setStatus }) => {
  const { id } = params; // e.g. "post:123@domain.com"
  const viewerId = req.user?.id || null;

  const feedCacheItem = await FeedItems.findOne({
    id,
    objectType: "Post",
    deletedAt: null,
    tombstoned: { $ne: true },
  }).lean();

  if (!feedCacheItem) {
    setStatus(404);
    set("error", "Post not found");
    return;
  }

  const followerMap = await buildFollowerMap([feedCacheItem.actorId]);
  const allowed = await canView(feedCacheItem, viewerId, { followerMap });

  if (!allowed) {
    setStatus(viewerId ? 403 : 401);
    set("error", viewerId ? "Access denied" : "Authentication required");
    return;
  }

  const enriched = await enrichWithCapabilities(feedCacheItem, viewerId, { followerMap });

  const response = {
    ...enriched.object,
    canReply: enriched.canReply,
    canReact: enriched.canReact,
    publishedAt: enriched.publishedAt,
    updatedAt: enriched.updatedAt,
    // Coarse visibility tier for ALL viewers (the sanitized object omits `to`,
    // and `to` is only added below for the owner). Clients gate share/reshape on
    // this; without it, non-owners can't tell a public post is public and the
    // share button fails closed. Mirrors the feed route (circles/posts.js).
    visibility: VISIBILITY_MAP[feedCacheItem.to] ?? "Public",
  };

  // Resolve `image`/`attachments` to client-usable URLs via the shared
  // enrichment transform. All of a post's files inherit the post's
  // visibility — use feedCacheItem.to (the coarse enum) rather than
  // response.to, which is only populated below for the owner and would
  // otherwise leak into this response for non-owners.
  const enrichTarget = { image: response.image, attachments: response.attachments, to: feedCacheItem.to };
  const protocol = req.headers["x-forwarded-proto"] || "https";
  await enrichAttachments([enrichTarget], { protocol });
  response.featuredImage = enrichTarget.featuredImage ?? null;
  response.attachments = enrichTarget.attachments ?? [];

  // Map event dates for all viewers
  if (feedCacheItem.type === 'Event') {
    response.startTime = response.event?.startDate ?? null;
    response.endTime   = response.event?.endDate   ?? null;
  }

  // For the owner, include raw editable fields from the Post model
  if (viewerId && viewerId === feedCacheItem.actorId) {
    const rawPost = await Post.findOne({ id: feedCacheItem.id })
      .select("source title href to canReply canReact tags location event")
      .lean();
    if (rawPost) {
      response.source = rawPost.source ?? null;
      response.title = rawPost.title ?? null;
      response.href = rawPost.href ?? null;
      response.to = rawPost.to ?? null;
      response.tags = rawPost.tags ?? [];
      response.location = rawPost.location ?? null;
      response.startTime = rawPost.event?.startDate ?? null;
      response.endTime   = rawPost.event?.endDate   ?? null;
    }
  }

  // Reactions: the viewer's own reaction (for the react button) and the
  // per-emoji breakdown (for the reacts bar on the post page).
  if (viewerId) {
    const mine = await ReactModel.findOne({ actorId: viewerId, target: id })
      .select("emoji")
      .lean();
    response.myReact = mine?.emoji ?? null;
  } else {
    response.myReact = null;
  }
  const reactGroups = await ReactModel.aggregate([
    { $match: { target: id } },
    { $group: { _id: "$emoji", count: { $sum: 1 } } },
    { $sort: { count: -1, _id: 1 } },
  ]);
  response.reactCounts = reactGroups
    .filter((g) => g._id)
    .map((g) => ({ emoji: g._id, count: g.count }));

  for (const [key, value] of Object.entries(response)) {
    set(key, value);
  }
});
