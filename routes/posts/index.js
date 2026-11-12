import express from "express";
import collection from "./collection.js";
import server from "./server.js";
import id from "./id.js";
import replies from "./replies.js";
import reacts from "./reacts.js";
import { FeedItems } from "#schema";
import feedItemToPost from "#methods/feed/feedItemToPost.js";
import { getSetting } from "#methods/settings/cache.js";
import { toRSS } from "#methods/rss/index.js";
import { excludeBlockedMuted } from "#methods/visibility/context.js";

const router = express.Router({ mergeParams: true });

// If a browser navigates directly to a post URL, serve the SPA so React Router
// can render it. Only ActivityPub clients (application/activity+json) and
// programmatic fetches (*/*) get the JSON API response.
// botDetect.js already handles crawlers before we get here.
function wantsHTML(req) {
  const accept = req.headers.accept || ''
  if (accept.includes('application/activity+json')) return false
  if (accept.includes('application/ld+json')) return false
  return accept.includes('text/html')
}

router.get("/", async (req, res, next) => {
  if (!("rss" in req.query)) return next();
  const domain = getSetting("domain");
  const siteName = getSetting("profile")?.name || "Kowloon";
  const docs = await FeedItems.find(
    await excludeBlockedMuted({ to: "public", tombstoned: { $ne: true }, objectType: "Post" }, null)
  )
    .sort({ publishedAt: -1 }).limit(20).lean();
  const proto = req.headers["x-forwarded-proto"] || "https";
  const base = `${proto}://${domain}`;
  const xml = toRSS(docs.map(feedItemToPost), {
    title: `${siteName} — Public Posts`,
    link: `${base}/`,
    feedLink: `${base}/posts?rss`,
    description: `Public posts from ${siteName}`,
    domain,
  });
  res.set("Content-Type", "text/xml; charset=UTF-8").send(xml);
}, collection);
router.get("/server", server);
router.get("/:id", (req, res, next) => wantsHTML(req) ? next('router') : id(req, res, next));
router.get("/:id/replies", replies);
router.get("/:id/reacts", reacts);

export default router;
