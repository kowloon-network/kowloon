// routes/home/index.js
// GET / — Server info endpoint (public profile + public settings)

import express from "express";
import route from "../utils/route.js";
import getSettings from "#methods/settings/get.js";
import { Settings } from "#schema";

const router = express.Router({ mergeParams: true });

const serverInfo = route(async ({ set }) => {
    const settings = await getSettings();

    set("type", "Service");
    set("name", settings?.profile?.name || "Kowloon");
    set("subtitle", settings?.profile?.subtitle || undefined);
    set("description", settings?.profile?.description || undefined);
    set("domain", settings?.domain || undefined);
    set("icon", settings?.profile?.icon || undefined);
    set("image", settings?.profile?.image || undefined);
    set("endpoints", {
      users: `/users`,
      posts: `/posts`,
      groups: `/groups`,
      pages: `/pages`,
      outbox: `/outbox`,
      inbox: `/inbox`,
    });

    // Public server settings — any setting with to: "@public" (excluding redacted UI types)
    const publicDocs = await Settings.find({
      to: "@public",
      "ui.type": { $ne: "redacted" },
      deletedAt: null,
    }).lean();
    const publicSettings = {};
    for (const doc of publicDocs) {
      publicSettings[doc.name] = doc.value;
    }
    set("settings", publicSettings);
  });

router.get("/", (req, res, next) => {
  // Browsers get the web app (SPA served further down the stack); ActivityPub /
  // API clients get the server-info JSON. Only fall through when the frontend is
  // actually mounted, so a frontend-less install still answers `/` with JSON.
  if (req.app.locals.frontendEnabled && req.accepts(["html", "json"]) === "html") {
    return next();
  }
  return serverInfo(req, res, next);
});

export default router;
