// routes/profile/index.js
// GET /profile — Consolidated server profile for federation peers.
//
// Returns everything a remote Kowloon server needs to populate its
// FederatedServer cache in a single round-trip: server metadata,
// stats, and preview lists of public circles, groups, and pages.
//
// Always unauthenticated — this is a public endpoint by design.
// All content is already @public; nothing sensitive is included.

import express from "express";
import route from "../utils/route.js";
import getSettings from "#methods/settings/get.js";
import { User, Post, Circle, Group, Page } from "#schema";

const router = express.Router({ mergeParams: true });

router.get(
  "/",
  route(
    async ({ req, set }) => {
      const protocol = req.headers["x-forwarded-proto"] || "https";
      const settings = await getSettings();
      const domain = settings?.domain;
      const profile = settings?.profile || {};

      // Run all DB queries in parallel
      const [userCount, postCount, circles, groups, pages] = await Promise.all([
        User.countDocuments({ deletedAt: null, active: { $ne: false } }),
        Post.countDocuments({ deletedAt: null, to: "@public" }),

        // Top 20 public circles by popularity
        Circle.find({ deletedAt: null, type: "Circle", to: "@public" })
          .select("id name summary icon memberCount reactCount")
          .sort({ reactCount: -1, memberCount: -1, createdAt: -1 })
          .limit(20)
          .lean(),

        // Top 20 public groups
        Group.find({ deletedAt: null, to: "@public" })
          .select("id name summary icon image memberCount rsvpPolicy")
          .sort({ memberCount: -1, createdAt: -1 })
          .limit(20)
          .lean(),

        // All public pages — just the preview fields
        Page.find({ deletedAt: null, to: "@public" })
          .select("title slug url icon")
          .sort({ order: 1, createdAt: -1 })
          .lean(),
      ]);

      const base = `${protocol}://${domain}`;

      // Absolutize relative asset paths (e.g. the default "/images/icons/
      // server.png") against this server's base so federated peers can fetch
      // them. Custom uploaded icons are already absolute file URLs.
      const toAbs = (v) =>
        v && !/^https?:\/\//i.test(v)
          ? `${base}${v.startsWith("/") ? "" : "/"}${v}`
          : v || null;

      set("type", "Service");
      set("domain", domain);
      set("name", profile.name || domain);
      set("icon", toAbs(profile.icon));
      set("image", toAbs(profile.image));
      set("description", profile.description || null);
      set("language", profile.language || []);
      set("location", profile.location || null);
      // No server-wide open-signup switch — see nodeinfo20.js for why this
      // stays present-and-false rather than being removed.
      set("openRegistrations", false);
      set("userCount", userCount);
      set("postCount", postCount);

      set(
        "circles",
        circles.map(({ _id, __v, ...c }) => ({
          ...c,
          url: `${base}/circles/${encodeURIComponent(c.id)}`,
        }))
      );

      set(
        "groups",
        groups.map(({ _id, __v, ...g }) => ({
          ...g,
          url: `${base}/groups/${encodeURIComponent(g.id)}`,
        }))
      );

      set(
        "pages",
        pages.map(({ _id, __v, slug, url, ...p }) => ({
          ...p,
          url: url || `${base}/pages/${encodeURIComponent(slug || p.title)}`,
        }))
      );
    },
    { allowUnauth: true }
  )
);

export default router;
