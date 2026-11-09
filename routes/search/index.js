// routes/search/index.js
// GET /search?q=term&searchIn=posts,users&page=1
//
// Local-only search: each server searches the content IT holds (locally-owned
// Posts/Pages/Groups/Bookmarks plus federated content already delivered). Every
// result passes the same consent gate as the timeline — buildVisibilityQuery for
// authored content, the always-discoverable rule for Users, and group
// discoverability for Groups. Network-wide (cross-server) search is a later
// phase (a third-party indexer); it is intentionally NOT part of this endpoint.

import express from "express";
import route from "../utils/route.js";
import { Post, Page, User, Group, Bookmark, FederatedServer } from "#schema";
import { activityStreamsCollection } from "../utils/oc.js";
import { getSetting } from "#methods/settings/cache.js";
import { getViewerContext } from "#methods/visibility/context.js";
import { buildVisibilityQuery } from "#methods/visibility/filter.js";
import { gateUserProfile } from "#methods/sanitize/object.js";
import { safeFetch } from "#methods/utils/safeUrl.js";
import { canSeeFolderChain } from "#methods/bookmarks/visibility.js";

// Federated handle patterns — mirrors /users/search logic
const REMOTE_HANDLE_RE = /^@?([^@]+)@([^@]+\.[^@]+)$/;
const SERVER_HANDLE_RE = /^@([^@]+\.[^@]+)$/;
const DIRECTORY_LIMIT  = 20;

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function proxyUserSearch(domain, q) {
  const url = `https://${domain}/users/search?q=${encodeURIComponent(q)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    // SECURITY: the domain here is user-supplied (a handle or id), so route the
    // request through the shared SSRF guard (blocks internal hosts, re-checks
    // every redirect hop).
    const res = await safeFetch(url, { headers: { Accept: "application/json" }, signal: ctrl.signal });
    if (!res.ok) return [];
    const data = await res.json();
    return data?.orderedItems ?? data?.items ?? [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

const SEARCHABLE = {
  Post: {
    model: Post,
    // `actor` is the embedded author subdoc the post cards render (avatar +
    // name); without it clients fall back to the bare handle.
    select: "id type title summary body url actor actorId tags to createdAt",
  },
  Page: {
    model: Page,
    select: "id type title slug summary url tags to createdAt",
  },
  User: {
    // `to` + `domain` are needed to gate personal-info profile fields; they are
    // stripped from the response below.
    model: User,
    select: "id type username profile url to domain",
  },
  Group: {
    model: Group,
    select: "id name summary icon url memberCount to createdAt",
  },
  Bookmark: {
    model: Bookmark,
    // parentFolder/actorId are only selected for the folder-chain check
    // below and stripped from the response.
    select: "id type title summary href target url tags to createdAt parentFolder actorId",
  },
};

// Per-type consent gate. Authored content (Post/Page/Bookmark) reuses the shared
// timeline visibility query. Users are always discoverable (profile baseline),
// minus blocked actors. Groups are discoverable when public, same-server, or the
// viewer is a member.
function typeFilter(typeName, ctx) {
  switch (typeName) {
    case "Post":
    case "Page":
    case "Bookmark":
      return buildVisibilityQuery(ctx);

    case "User": {
      const f = { deletedAt: null, active: true };
      if (ctx.blockedActorIds?.size) f.id = { $nin: [...ctx.blockedActorIds] };
      return f;
    }

    case "Group": {
      if (!ctx.isAuthenticated) return { deletedAt: null, to: "@public" };
      const or = [{ to: "@public" }];
      if (ctx.viewerDomain) or.push({ to: `@${ctx.viewerDomain}` });
      if (ctx.groupIds.size) or.push({ id: { $in: [...ctx.groupIds] } });
      return { deletedAt: null, $or: or };
    }

    default:
      return { deletedAt: null, to: "@public" };
  }
}

const router = express.Router({ mergeParams: true });

router.get(
  "/",
  route(async ({ req, query, user, set, setStatus }) => {
    const q = (query.q || "").trim();
    if (!q) {
      setStatus(400);
      set("error", "Search query (q) is required");
      return;
    }

    // searchIn maps client-friendly names to SEARCHABLE keys
    const SEARCH_IN_MAP = {
      posts: "Post",
      pages: "Page",
      users: "User",
      groups: "Group",
      bookmarks: "Bookmark",
      servers: "Server",
    };
    // "Server" isn't a SEARCHABLE model (it's the FederatedServer cache, handled
    // by its own pass); include it in the default set so a bare search surfaces
    // known servers alongside everything else.
    const ALL_TYPES = [...Object.keys(SEARCHABLE), "Server"];

    let requestedTypes;
    if (query.searchIn) {
      requestedTypes = query.searchIn
        .split(",")
        .map((s) => SEARCH_IN_MAP[s.trim()])
        .filter(Boolean);
      if (requestedTypes.length === 0) requestedTypes = ALL_TYPES;
    } else if (query.type) {
      requestedTypes = [query.type];
    } else {
      requestedTypes = ALL_TYPES;
    }
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(Math.max(1, parseInt(query.limit, 10) || 20), 50);
    const skip = (page - 1) * limit;

    const ctx = await getViewerContext(user?.id || null);
    const localDomain = (getSetting("domain") || "").toLowerCase();

    // Collect results from all requested types
    const allResults = [];

    // Federated user lookup: handle-shaped queries bypass the local text index
    const remoteMatch = q.match(REMOTE_HANDLE_RE);
    const serverMatch = !remoteMatch && q.match(SERVER_HANDLE_RE);

    if ((remoteMatch || serverMatch) && requestedTypes.includes("User")) {
      // Remove User from the text-search pass — we resolve it federatedly instead
      requestedTypes = requestedTypes.filter((t) => t !== "User");

      let federatedUsers = [];

      if (remoteMatch) {
        const [, username, domain] = remoteMatch;
        if (domain.toLowerCase() === localDomain) {
          const doc = await User.findOne({ username, active: true, deletedAt: null })
            .select("id username profile url")
            .lean();
          if (doc) federatedUsers = [doc];
        } else {
          const items = await proxyUserSearch(domain, q);
          // Map proxy shape { id, username, name, icon } → { id, username, profile: { name, icon } }
          federatedUsers = items.map((u) => ({
            id: u.id,
            username: u.username,
            profile: { name: u.name ?? u.username, icon: u.icon ?? null },
            url: u.url ?? null,
            _remote: true,
          }));
        }
      } else if (serverMatch) {
        const [, domain] = serverMatch;
        if (domain.toLowerCase() === localDomain) {
          federatedUsers = await User.find({ to: "@public", active: true, deletedAt: null })
            .sort({ postCount: -1 })
            .limit(DIRECTORY_LIMIT)
            .select("id username profile url")
            .lean();
        } else {
          const items = await proxyUserSearch(domain, q);
          federatedUsers = items.map((u) => ({
            id: u.id,
            username: u.username,
            profile: { name: u.name ?? u.username, icon: u.icon ?? null },
            url: u.url ?? null,
            _remote: true,
          }));
        }
      }

      for (const u of federatedUsers) {
        allResults.push({ ...u, _searchType: "User", _score: 10 });
      }
    }

    // ── Server discovery: match the FederatedServer cache by partial domain or
    // name, so "@kwln" (or plain "kwln") returns known servers whose id contains
    // it — the atomic building block of remote-server discovery.
    if (requestedTypes.includes("Server")) {
      const term = q.replace(/^@/, "").trim();
      if (term) {
        const rx = new RegExp(escapeRegex(term), "i");
        const servers = await FederatedServer.find({
          // Hide admin-suppressed servers; unreachable/slow are still real
          // known servers worth surfacing in discovery.
          status: { $nin: ["suspended", "blocked"] },
          $or: [{ domain: rx }, { name: rx }],
        })
          .select(
            "domain name icon image description language location userCount postCount openRegistrations status discoveredAt"
          )
          .limit(DIRECTORY_LIMIT)
          .lean();
        for (const s of servers) {
          allResults.push({
            ...s,
            id: s.domain,
            _searchType: "Server",
            // Rank explicit "@"-prefixed server searches above plain text hits.
            _score: q.startsWith("@") ? 12 : 6,
          });
        }
      }
    }

    await Promise.all(
      requestedTypes
        .filter((t) => SEARCHABLE[t])
        .map(async (typeName) => {
          const { model, select } = SEARCHABLE[typeName];

          // Users: regex substring match so partial terms like "jzell" find "jzellis".
          // $text is word-tokenised and won't match partial words.
          if (typeName === "User") {
            const re = new RegExp(
              q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
              "i"
            );
            const filter = {
              ...typeFilter("User", ctx),
              $or: [{ username: re }, { "profile.name": re }],
            };
            try {
              const docs = await model
                .find(filter)
                .select(select)
                .limit(limit * 2)
                .lean();
              for (const doc of docs) {
                allResults.push({ ...doc, _searchType: "User", _score: 5 });
              }
            } catch {
              // skip
            }
            return;
          }

          const textFilter = {
            ...typeFilter(typeName, ctx),
            $text: { $search: q },
          };

          try {
            const docs = await model
              .find(textFilter, { score: { $meta: "textScore" } })
              .select(select)
              .sort({ score: { $meta: "textScore" } })
              .limit(limit * 2) // Over-fetch to merge across types
              .lean();

            for (const doc of docs) {
              if (typeName === "Bookmark") {
                // SECURITY: a nominally @public bookmark inside a private
                // folder must stay hidden (read-time folder inheritance, same
                // rule as GET /users/:id/bookmarks). buildVisibilityQuery only
                // checks the bookmark's own `to`.
                const isOwner = ctx.viewerId && doc.actorId === ctx.viewerId;
                if (!isOwner && !(await canSeeFolderChain(doc.parentFolder, ctx))) continue;
                delete doc.parentFolder;
                delete doc.actorId;
              }
              allResults.push({
                ...doc,
                _searchType: typeName,
                _score: doc.score || 0,
              });
            }
          } catch {
            // Text index may not exist for this model; skip
          }
        })
    );

    // Sort by relevance, then paginate
    allResults.sort((a, b) => (b._score || 0) - (a._score || 0));
    const total = allResults.length;
    const paged = allResults.slice(skip, skip + limit).map((r) => {
      const { _score, score, ...rest } = r;
      // Gate personal-info profile fields per viewer; drop the helper fields
      // (`to`/`domain`) only selected to compute that gate.
      if (rest._searchType === "User") {
        if (rest._remote) {
          // Already gated by the remote server; profile is already shaped correctly
          delete rest._remote;
        } else {
          rest.profile = gateUserProfile(rest, ctx);
          delete rest.to;
          delete rest.domain;
        }
      }
      return rest;
    });

    const domain = getSetting("domain");
    const protocol = req.headers["x-forwarded-proto"] || "https";
    const base = `${protocol}://${domain}/search`;

    const collection = activityStreamsCollection({
      id: `${base}?q=${encodeURIComponent(q)}&page=${page}`,
      orderedItems: paged,
      totalItems: total,
      page,
      itemsPerPage: limit,
      baseUrl: `${base}?q=${encodeURIComponent(q)}`,
    });

    for (const [key, value] of Object.entries(collection)) {
      set(key, value);
    }
  })
);

export default router;
