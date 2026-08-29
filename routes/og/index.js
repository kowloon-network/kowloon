// routes/og/index.js
// Serves server-level Open Graph assets at clean URLs so social-media scrapers
// don't choke on the encoded `file:id@domain` path segments in /files/:id.
//
// GET /og/image  -> streams the server hero image (profile.image or profile.icon)
// GET /og/icon   -> streams the server icon (profile.icon)

import express from "express";
import { getSetting } from "#methods/settings/cache.js";
import serveFile from "../files/serve.js";

const router = express.Router({ mergeParams: true });

function extractFileId(imageValue) {
  if (!imageValue) return null;
  if (imageValue.startsWith("file:")) return imageValue;
  if (imageValue.startsWith("http")) {
    // Strip the origin and /files/ prefix to get the raw file ID
    try {
      const u = new URL(imageValue);
      const parts = u.pathname.split("/files/");
      if (parts.length < 2) return null;
      return decodeURIComponent(parts[1]);
    } catch {
      return null;
    }
  }
  return null;
}

function ogImageHandler(field) {
  return async (req, res) => {
    const profile = getSetting("profile") || {};
    const raw = profile[field] || (field === "image" ? profile.icon : null);
    if (!raw) return res.status(404).end();

    const fileId = extractFileId(raw);
    if (fileId) {
      req.params = { ...req.params, id: fileId };
      return serveFile(req, res);
    }

    // Not a Kowloon file reference — e.g. the default, un-customized profile
    // icon, which points at a bundled static asset (/logo.png) rather than
    // an uploaded file. Redirect to it directly instead of 404ing; the
    // static-file middleware already serves public/ at the app root, and a
    // relative Location resolves against whichever domain this request came
    // in on (correct for pics.<domain> too, with no extra domain logic).
    if (raw.startsWith("/")) return res.redirect(raw);

    return res.status(404).end();
  };
}

router.get("/image", ogImageHandler("image"));
router.get("/icon", ogImageHandler("icon"));

export default router;
