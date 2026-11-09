// routes/posts/reacts.js
// GET /posts/:id/reacts — Reactions to a post

import route from "../utils/route.js";
import { activityStreamsCollection } from "../utils/oc.js";
import { React } from "#schema";
import { excludeBlockedMuted } from "#methods/visibility/context.js";
import { authorizeInteraction } from "#methods/feed/visibility.js";
import { getSetting } from "#methods/settings/cache.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export default route(async ({ req, query, user, set, setStatus }) => {
  const targetId = decodeURIComponent(req.params.id);

  // SECURITY: this used to list reactions (who reacted, with what) for ANY
  // object id, with no check against the parent's own visibility -- a
  // circle-only post's reactions leaked to anyone who knew its id. Same gate
  // routes/posts/replies.js uses (#58): visibility + block, no capability.
  const authz = await authorizeInteraction({ actorId: user?.id || null, targetId });
  if (!authz.ok) {
    setStatus(authz.status);
    set("error", authz.message);
    return;
  }

  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(
    Math.max(1, parseInt(query.limit, 10) || DEFAULT_LIMIT),
    MAX_LIMIT
  );
  const skip = (page - 1) * limit;

  const filter = { target: targetId, deletedAt: null };
  await excludeBlockedMuted(filter, user?.id);

  const [docs, total] = await Promise.all([
    React.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    React.countDocuments(filter),
  ]);

  const domain = getSetting("domain");
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const base = `${protocol}://${domain}${req.baseUrl}`;

  const collection = activityStreamsCollection({
    id: page ? `${base}?page=${page}` : base,
    orderedItems: docs,
    totalItems: total,
    page,
    itemsPerPage: limit,
    baseUrl: base,
  });
  for (const [key, value] of Object.entries(collection)) set(key, value);
});
