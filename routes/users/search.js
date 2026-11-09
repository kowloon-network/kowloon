// GET /users/search?q=<term>
// Auth-required for plain-text/handle searches (local DB).
// Public for remote patterns — only @public data is ever returned.
//
// Three modes:
//   @user@domain  — if local, DB lookup; if remote, proxy to that server
//   @domain       — if local, return top 20 @public users by postCount;
//                   if remote, proxy to that server
//   plain text    — local DB search by username / display name (auth required)

import route from "../utils/route.js";
import { User } from "#schema";
import { getSetting } from "#methods/settings/cache.js";
import { safeFetch } from "#methods/utils/safeUrl.js";

const REMOTE_HANDLE_RE = /^@?([^@]+)@([^@]+\.[^@]+)$/;
const SERVER_HANDLE_RE = /^@([^@]+\.[^@]+)$/;
const DIRECTORY_LIMIT  = 20;

async function proxySearch(domain, q) {
  const url = `https://${domain}/users/search?q=${encodeURIComponent(q)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    // SECURITY: the domain here is user-supplied (a handle or id), so route the
    // request through the shared SSRF guard (blocks internal hosts, re-checks
    // every redirect hop).
    const res = await safeFetch(url, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.warn(`[users/search] proxy to ${domain} returned ${res.status}`);
      return [];
    }
    const data = await res.json();
    return data?.orderedItems ?? data?.items ?? [];
  } catch (err) {
    console.warn(`[users/search] proxy to ${domain} failed:`, err.message);
    return [];
  } finally {
    clearTimeout(t);
  }
}

export default route(
  async ({ query, user, set, setStatus }) => {
    const q = (query.q || "").trim();
    if (!q) {
      setStatus(400);
      set("error", "Missing 'q' query parameter");
      return;
    }

    const limit = Math.min(Math.max(1, parseInt(query.limit, 10) || 10), 25);
    const localDomain = getSetting("domain") || process.env.DOMAIN || "";

    // ── @user@domain ─────────────────────────────────────────────────────────
    const remoteMatch = q.match(REMOTE_HANDLE_RE);
    if (remoteMatch) {
      const username = remoteMatch[1];
      const domain   = remoteMatch[2];

      if (domain.toLowerCase() === localDomain.toLowerCase()) {
        // Local user lookup
        const doc = await User.findOne({
          username,
          active: true,
          deletedAt: null,
        })
          .select("id username profile.name profile.icon url")
          .lean();

        if (doc) {
          set("orderedItems", [{
            id:       doc.id,
            username: doc.username,
            name:     doc.profile?.name ?? doc.username,
            icon:     doc.profile?.icon ?? null,
            url:      doc.url ?? null,
          }]);
          set("totalItems", 1);
        } else {
          set("orderedItems", []);
          set("totalItems", 0);
        }
        return;
      }

      // Remote — proxy
      const items = await proxySearch(domain, q);
      set("orderedItems", items);
      set("totalItems", items.length);
      return;
    }

    // ── @domain (server directory) ────────────────────────────────────────────
    const serverMatch = q.match(SERVER_HANDLE_RE);
    if (serverMatch) {
      const domain = serverMatch[1];

      if (domain.toLowerCase() === localDomain.toLowerCase()) {
        // Return our top public users by post count
        const docs = await User.find({ to: "@public", active: true, deletedAt: null })
          .sort({ postCount: -1 })
          .limit(DIRECTORY_LIMIT)
          .select("id username profile.name profile.icon url postCount")
          .lean();

        const items = docs.map((u) => ({
          id:        u.id,
          username:  u.username,
          name:      u.profile?.name ?? u.username,
          icon:      u.profile?.icon ?? null,
          url:       u.url ?? null,
          postCount: u.postCount ?? 0,
        }));
        set("orderedItems", items);
        set("totalItems", items.length);
        return;
      }

      // Remote — proxy
      const items = await proxySearch(domain, q);
      set("orderedItems", items);
      set("totalItems", items.length);
      return;
    }

    // ── Plain text / local @handle — auth required ────────────────────────────
    if (!user) {
      setStatus(401);
      set("error", "Authentication required");
      return;
    }

    const isHandle = q.startsWith("@");
    const term = isHandle ? q.replace(/^@/, "") : q;
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

    const filter = {
      active: true,
      deletedAt: null,
      $or: isHandle
        ? [{ username: re }]
        : [{ username: re }, { "profile.name": re }],
    };

    const docs = await User.find(filter)
      .select("id username profile.name profile.icon url")
      .limit(limit)
      .lean();

    const items = docs.map((u) => ({
      id:       u.id,
      username: u.username,
      name:     u.profile?.name ?? u.username,
      icon:     u.profile?.icon ?? null,
      url:      u.url ?? null,
    }));

    set("orderedItems", items);
    set("totalItems", items.length);
  },
  { allowUnauth: true }
);
