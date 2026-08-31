// routes/admin/index.js
// Admin API — all routes require server admin membership

import express from "express";
import { jwtVerify, importSPKI } from "jose";
import isServerAdmin from "#methods/auth/isServerAdmin.js";
import getSettings from "#methods/settings/get.js";
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
  try {
    const auth = req.headers.authorization || "";
    const match = auth.match(/^(?:Bearer|Token)\s+(.+)$/i);
    const token = match?.[1]?.trim();

    if (!token) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const settings = await getSettings();
    const pub = settings?.publicKey?.replace(/\\n/g, "\n").trim();
    if (!pub) return res.status(500).json({ error: "Server misconfigured" });

    const publicKey = await importSPKI(pub, "RS256");
    const { payload } = await jwtVerify(token, publicKey, {
      algorithms: ["RS256"],
      issuer: `https://${settings.domain}`,
    });

    const userId = payload?.user?.id || payload?.id || payload?.sub;
    if (!userId) return res.status(401).json({ error: "Invalid token" });

    const admin = await isServerAdmin(userId);
    if (!admin) {
      return res.status(403).json({ error: "Server admin access required" });
    }

    req.user = payload.user || { id: userId };
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
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

export default router;
