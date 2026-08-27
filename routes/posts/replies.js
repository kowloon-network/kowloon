// routes/posts/replies.js
// GET /posts/:id/replies — Replies to a post
//
// For local posts: query the local Reply collection.
// For remote posts: proxy to the parent post's home server, which holds the
// canonical aggregate (every reply federates to it). Third-party servers do
// not keep per-server reply state — the parent host is the single source of
// truth, so deletes/edits never need to fan out beyond it.

import route from "../utils/route.js";
import { Reply, Post } from "#schema";
import { activityStreamsCollection } from "../utils/oc.js";
import { getSetting } from "#methods/settings/cache.js";
import kowloonId from "#methods/parse/kowloonId.js";
import { excludeBlockedMuted } from "#methods/visibility/context.js";
import { enrichAttachments } from "#methods/files/enrichAttachments.js";
import { authorizeInteraction } from "#methods/feed/visibility.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

async function serveLocal(ctx) {
  const { req, query, user, set, setStatus } = ctx;
  const postId = decodeURIComponent(req.params.id);

  // #58: this previously served any post's replies to anyone who knew/guessed
  // the id, with zero check against the parent post's own visibility. Same
  // gate Reply creation already uses (ActivityParser/handlers/Reply/index.js)
  // — omit `capability` to only check visibility+block, not canReply.
  const authz = await authorizeInteraction({ actorId: user?.id || null, targetId: postId });
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

  const filter = { target: postId, deletedAt: null };
  await excludeBlockedMuted(filter, user?.id);

  const [docs, total, parentPost] = await Promise.all([
    Reply.find(filter).sort({ createdAt: 1 }).skip(skip).limit(limit).lean(),
    Reply.countDocuments(filter),
    Post.findOne({ id: postId }).select("to").lean(),
  ]);

  // Reply.to is always blank by design — visibility is inherited from the
  // parent post, so enrichAttachments (which reads item.to to decide
  // public-vs-restricted) needs the parent's real `to` supplied externally.
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const enrichTargets = docs.map((doc) => ({
    image: doc.image,
    attachments: doc.attachments,
    to: parentPost?.to || "@public",
  }));
  await enrichAttachments(enrichTargets, { protocol });
  docs.forEach((doc, i) => {
    doc.featuredImage = enrichTargets[i].featuredImage ?? null;
    doc.attachments = enrichTargets[i].attachments ?? [];
  });

  const domain = getSetting("domain");
  const base = `${protocol}://${domain}${req.baseUrl}${req.path}`;

  const collection = activityStreamsCollection({
    id: page ? `${base}?page=${page}` : base,
    orderedItems: docs,
    totalItems: total,
    page,
    itemsPerPage: limit,
    baseUrl: base,
  });

  for (const [key, value] of Object.entries(collection)) {
    set(key, value);
  }
}

async function proxyToRemote(ctx, remoteDomain, postId) {
  const { query, set, setStatus } = ctx;

  const params = new URLSearchParams();
  if (query.page) params.append("page", String(query.page));
  if (query.limit) params.append("limit", String(query.limit));
  const qs = params.toString();
  const url = `https://${remoteDomain}/posts/${encodeURIComponent(postId)}/replies${qs ? "?" + qs : ""}`;

  const localDomain = getSetting("domain") || "unknown";

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/activity+json",
        "User-Agent": `Kowloon/${localDomain}`,
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      setStatus(response.status);
      set("error", `Remote replies fetch failed (${response.status})`);
      return;
    }

    const body = await response.json();
    for (const [key, value] of Object.entries(body)) {
      set(key, value);
    }
  } catch (err) {
    setStatus(502);
    set("error", `Failed to fetch replies from ${remoteDomain}: ${err.message}`);
  }
}

export default route(async (ctx) => {
  const { req } = ctx;
  const postId = decodeURIComponent(req.params.id);
  const localDomain = (getSetting("domain") || "").toLowerCase();
  const parsed = kowloonId(postId);
  const parentDomain = parsed?.domain?.toLowerCase();

  if (!parentDomain || parentDomain === localDomain) {
    return serveLocal(ctx);
  }

  return proxyToRemote(ctx, parsed.domain, postId);
});
