// routes/admin/index.js
// Admin API — all routes require server admin membership

import express from "express";
import isServerAdmin from "#methods/auth/isServerAdmin.js";
import { authenticateRequest, AuthUnavailable } from "#routes/utils/route.js";
import { create, list, getOne, deactivate } from "./invites.js";
import activitiesRouter from "./activities.js";
import usersRouter from "./users.js";
import groupsRouter from "./groups.js";
import postsRouter from "./posts.js";
import circlesRouter from "./circles.js";
import flaggedRouter from "./flagged.js";
import settingsRouter from "./settings.js";
import pagesRouter from "./pages.js";
import bookmarksRouter from "./bookmarks.js";
import systemRouter from "./system.js";
import backupRouter from "./backup.js";
import sectionsRouter from "./sections.js";
import discoveryRouter from "./discovery.js";
import serversRouter from "./servers.js";
import blocklistRouter from "./blocklist.js";

const router = express.Router({ mergeParams: true });

// Browser navigations to /admin/* get the SPA; the React Router handles them client-side.
// Authenticated requests (Authorization header present) always go through as API calls,
// even if their Accept header prefers HTML (e.g. binary download via fetch()).
router.use((req, res, next) => {
  if (
    req.app.locals.frontendEnabled &&
    !req.headers.authorization &&
    req.accepts(["html", "json"]) === "html"
  ) {
    return next("router");
  }
  next();
});

// Admin auth guard middleware
router.use(async (req, res, next) => {
  // SECURITY (2026-11-09): this guard used to verify the JWT itself and only
  // refused user.scope === "visiting". A forged cross-server login produced a
  // token with user.visiting === true naming a LOCAL admin, which sailed
  // through. It now uses the same authenticateRequest() as every route()
  // handler (revocation, tokensValidAfter, local-domain check, visiting
  // session validation), then refuses BOTH kinds of cross-server token.
  let user;
  try {
    user = await authenticateRequest(req);
  } catch (err) {
    if (err instanceof AuthUnavailable) {
      return res.status(503).json({ error: "Temporarily unable to verify your session" });
    }
    return res.status(401).json({ error: "Invalid or expired token" });
  }
  if (!user) return res.status(401).json({ error: "Authentication required" });

  if (user.scope === "visiting" || user.visiting) {
    return res
      .status(403)
      .json({ error: "A visiting session cannot use admin routes" });
  }

  const admin = await isServerAdmin(user.id);
  if (!admin) {
    return res.status(403).json({ error: "Server admin access required" });
  }
  next();
});

// ── Invites ───────────────────────────────────────────────────────────────────

router.post("/invites", create);
router.get("/invites", list);
router.get("/invites/:id", getOne);
router.delete("/invites/:id", deactivate);

// ── Sub-routers ───────────────────────────────────────────────────────────────

router.use("/activities", activitiesRouter);
router.use("/users", usersRouter);
router.use("/groups", groupsRouter);
router.use("/posts", postsRouter);
router.use("/circles", circlesRouter);
router.use("/flagged", flaggedRouter);
router.use("/settings", settingsRouter);
router.use("/pages", pagesRouter);
router.use("/bookmarks", bookmarksRouter);
router.use("/system", systemRouter);
router.use("/backup", backupRouter);
router.use("/sections", sectionsRouter);
router.use("/discovery", discoveryRouter);
router.use("/servers", serversRouter);
router.use("/blocklist", blocklistRouter);

export default router;
