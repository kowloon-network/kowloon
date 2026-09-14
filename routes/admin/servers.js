// routes/admin/servers.js
// Server-level moderation: block or defederate another server.
//
// Two levels, defined in schema/FederatedServer.js and enforced in
// routes/inbox/post.js:
//   blocked   — refuse replies and reacts from that server, but keep pulling
//               its content so local users who already subscribe don't
//               silently lose what they follow.
//   suspended — full defederation. Nothing in, nothing out, hidden from
//               search and discovery.

import express from "express";
import route from "../utils/route.js";
import { FederatedServer } from "#schema";
import parseServerDomain from "#methods/parse/serverDomain.js";
import getSettings from "#methods/settings/get.js";

const router = express.Router({ mergeParams: true });

const LEVELS = new Set(["blocked", "suspended"]);

function present(doc) {
  return {
    domain: doc.domain,
    name: doc.profile?.name || doc.name || null,
    icon: doc.profile?.icon || null,
    status: doc.status,
    reason: doc.status === "suspended" ? doc.suspendedReason : doc.blockedReason,
    since: doc.status === "suspended" ? doc.suspendedAt : doc.blockedAt,
    software: doc.software || null,
  };
}

// GET /admin/servers/moderated — every server currently blocked or suspended.
router.get(
  "/moderated",
  route(
    async ({ set }) => {
      const docs = await FederatedServer.find({
        status: { $in: ["blocked", "suspended"] },
      })
        .select("domain name profile status blockedAt blockedReason suspendedAt suspendedReason software")
        .sort({ domain: 1 })
        .lean();

      set("servers", docs.map(present));
      set("total", docs.length);
    },
    { allowUnauth: false }
  )
);

// POST /admin/servers/moderate { server, level, reason? }
// `server` accepts whatever the admin has to hand: "@example.org",
// "https://example.org", "example.org" — see methods/parse/serverDomain.js.
router.post(
  "/moderate",
  route(
    async ({ body, set, setStatus }) => {
      const domain = parseServerDomain(body?.server);
      if (!domain) {
        setStatus(400);
        set("error", "Enter a server domain, e.g. example.org");
        return;
      }

      const level = body?.level;
      if (!LEVELS.has(level)) {
        setStatus(400);
        set("error", 'level must be "blocked" or "suspended"');
        return;
      }

      // Blocking your own server would cut every local interaction at the
      // inbox gate, which is unrecoverable from this UI.
      const settings = await getSettings();
      if (domain === settings?.domain) {
        setStatus(400);
        set("error", "You can't block your own server");
        return;
      }

      const reason =
        typeof body?.reason === "string" && body.reason.trim()
          ? body.reason.trim()
          : undefined;

      // upsert: an admin may well block a server this one has never met.
      if (level === "suspended") {
        await FederatedServer.suspendServer(domain, reason);
      } else {
        await FederatedServer.blockServer(domain, reason);
      }

      const doc = await FederatedServer.findOne({ domain })
        .select("domain name profile status blockedAt blockedReason suspendedAt suspendedReason software")
        .lean();

      setStatus(201);
      set("ok", true);
      set("server", present(doc));
    },
    { allowUnauth: false }
  )
);

// POST /admin/servers/unmoderate { server }
// Clears whichever level is set and puts the server back to active.
router.post(
  "/unmoderate",
  route(
    async ({ body, set, setStatus }) => {
      const domain = parseServerDomain(body?.server);
      if (!domain) {
        setStatus(400);
        set("error", "Enter a server domain, e.g. example.org");
        return;
      }

      const doc = await FederatedServer.findOne({ domain })
        .select("status")
        .lean();
      if (!doc) {
        setStatus(404);
        set("error", "That server isn't blocked");
        return;
      }

      if (doc.status === "suspended") {
        await FederatedServer.unsuspendServer(domain);
      } else if (doc.status === "blocked") {
        await FederatedServer.unblockServer(domain);
      } else {
        setStatus(409);
        set("error", "That server isn't blocked");
        return;
      }

      set("ok", true);
      set("domain", domain);
    },
    { allowUnauth: false }
  )
);

export default router;
