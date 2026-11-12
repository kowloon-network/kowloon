// routes/groups/index.js

import express from "express";
import collection from "./collection.js";
import id from "./id.js";
import members from "./members.js";
import pending from "./pending.js";
import posts from "./posts.js";
import inboxPost from "../inbox/post.js";
import { Group, FeedItems } from "#schema";
import feedItemToPost from "#methods/feed/feedItemToPost.js";
import { getSetting } from "#methods/settings/cache.js";
import { toRSS } from "#methods/rss/index.js";
import { excludeBlockedMuted } from "#methods/visibility/context.js";

const router = express.Router({ mergeParams: true });

router.get("/", collection);
router.get("/:id", (req, res, next) => {
  const accept = req.headers.accept || ''
  if (accept.includes('text/html') && !accept.includes('application/activity+json') && !accept.includes('application/ld+json')) return next('router')
  id(req, res, next)
});
router.get("/:id/members", members);
router.get("/:id/pending", pending);
router.get("/:id/posts", async (req, res, next) => {
  if (!("rss" in req.query)) return next();
  const domain = getSetting("domain");
  const groupId = decodeURIComponent(req.params.id);
  const group = await Group.findOne({ id: groupId, to: "@public", deletedAt: null }).lean();
  if (!group) return res.status(404).json({ error: "Not found" });
  const docs = await FeedItems.find(
    await excludeBlockedMuted({ group: groupId, tombstoned: { $ne: true }, objectType: "Post" }, null)
  )
    .sort({ publishedAt: -1 }).limit(20).lean();
  const proto = req.headers["x-forwarded-proto"] || "https";
  const base = `${proto}://${domain}`;
  const xml = toRSS(docs.map(feedItemToPost), {
    title: `${group.name || groupId} -- ${domain}`,
    link: `${base}/groups/${encodeURIComponent(groupId)}`,
    feedLink: `${base}/groups/${encodeURIComponent(groupId)}/posts?rss`,
    description: group.summary || `Posts from the ${group.name || groupId} group`,
    domain,
  });
  res.set("Content-Type", "text/xml; charset=UTF-8").send(xml);
}, posts);
// S2S: remote servers deliver to group inbox
router.post("/:id/inbox", inboxPost);

export default router;
