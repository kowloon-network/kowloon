// routes/nodeinfo/index.js
// GET /nodeinfo/2.0 — NodeInfo 2.0 document. Auto-mounted at /nodeinfo per
// routes/index.js's directory-name convention (this file supplies the /2.0
// sub-route the spec requires).
//
// This used to live in routes/well-known/nodeinfo20.js, reached via
// routes/well-known/index.js doing router.use("/../nodeinfo/2.0", nodeinfo20)
// — a relative-path trick meant to place it outside that router's own
// /.well-known prefix, since NodeInfo's actual document is required to live
// at the domain root, not under .well-known (only the *discovery* link at
// /.well-known/nodeinfo points into it — see routes/well-known/nodeinfo.js,
// which has always correctly pointed at https://<domain>/nodeinfo/2.0).
//
// But Express mount paths are plain string prefixes matched against
// req.url, not filesystem-style paths — a literal "/../" segment can never
// appear in a real incoming request path, so that mount never matched
// anything. Every request silently fell through to the SPA catch-all
// instead, and NodeInfo was unreachable in production. Moving the handler
// to its own top-level route directory (the same pattern routes/config/
// already uses) fixes it by construction — no more relative-mount trick.
import express from "express";
import { User, Post } from "#schema";
import getSettings from "#methods/settings/get.js";

const router = express.Router({ mergeParams: true });

router.get("/2.0", async (req, res) => {
  const domain = process.env.DOMAIN || "localhost";
  const base = `https://${domain}`;
  const version = process.env.APP_VERSION || "1.0.0";

  const [settings, userTotal, localPosts] = await Promise.all([
    getSettings().catch(() => ({})),
    User.countDocuments({ deletedAt: null }).catch(() => 0),
    Post.countDocuments({ deletedAt: null }).catch(() => 0),
  ]);

  const siteTitle = settings?.profile?.name || process.env.SITE_TITLE || "Kowloon";

  res.json({
    version: "2.0",
    software: { name: "kowloon", version },
    protocols: ["activitypub"],
    services: { inbound: [], outbound: [] },
    // Kowloon has no server-wide open-signup switch — registration always
    // requires an invite (individual or an admin-issued unlimited link).
    // false is the accurate NodeInfo answer, not a placeholder; the field
    // stays present because other fediverse software reads it.
    openRegistrations: false,
    usage: { users: { total: userTotal }, localPosts },
    metadata: {
      siteTitle,
      domain,
      instanceActor: `${base}/users/kowloon`,
    },
  });
});

export default router;
