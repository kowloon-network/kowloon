import express from "express";
import { getSetting } from "#methods/settings/cache.js";

const router = express.Router({ mergeParams: true });

// Public runtime config for the frontend.
// Served at /config.json — fetched by the frontend container on load.
router.get("/", (_req, res) => {
  const domain = getSetting("domain");
  res.json({
    apiUrl: `https://${domain}`,
    domain,
    siteTitle: getSetting("siteTitle") || getSetting("profile")?.name || "Kowloon",
  });
});

export default router;
