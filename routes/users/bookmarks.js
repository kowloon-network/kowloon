// routes/users/bookmarks.js
// GET /users/:id/bookmarks — A user's bookmarks, viewer-scoped and folder-aware.
//
// Owner sees everything they own. Other viewers get items that pass the
// standard buildVisibilityQuery AND whose ancestor folder chain is also
// visible. Three query modes via ?parentFolder:
//   - omitted              → flat-all for owner; root-only for non-owner
//   - "root"               → root-only (parentFolder missing) for everyone
//   - "<folderId>"         → that folder's direct children, ancestor-checked

import route from "../utils/route.js";
import { Bookmark } from "#schema";
import { activityStreamsCollection } from "../utils/oc.js";
import { getViewerContext } from "#methods/visibility/context.js";
import { buildVisibilityQuery } from "#methods/visibility/filter.js";
import { canSeeFolderChain } from "#methods/bookmarks/visibility.js";
import { getSetting } from "#methods/settings/cache.js";
import kowloonId from "#methods/parse/kowloonId.js";
import isLocalDomain from "#methods/parse/isLocalDomain.js";
import { safeFetch } from "#methods/utils/safeUrl.js";

const SELECT =
  "id type title summary href target image tags to parentFolder actorId url body createdAt updatedAt";

// Bookmarks never federate or get cached locally (personal utility -- see
// schema/Bookmark.js), so unlike remote User profiles there's no local shadow
// copy to read. Fetch the remote user's bookmarks live from their own server
// instead. The request is anonymous (we have no session on the remote
// server), so it only ever sees whatever that server shows a logged-out
// viewer -- i.e. its @public bookmarks/folders. That's the correct scope:
// there's no mechanism for a Kowloon user to grant a specific remote viewer
// server-only access to their bookmarks. Fails soft (empty result) on any
// network error, timeout, or non-2xx -- someone else's server being slow or
// down shouldn't surface as a hard error here.
async function fetchRemoteBookmarks(userId, remoteDomain, query) {
  const params = new URLSearchParams();
  if (query.parentFolder) params.set("parentFolder", query.parentFolder);
  if (query.type) params.set("type", query.type);
  if (query.page) params.set("page", query.page);
  if (query.limit) params.set("limit", query.limit);
  const qs = params.toString();
  const url = `https://${remoteDomain}/users/${encodeURIComponent(userId)}/bookmarks${qs ? `?${qs}` : ""}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    // SECURITY: the domain here is user-supplied (a handle or id), so route the
    // request through the shared SSRF guard (blocks internal hosts, re-checks
    // every redirect hop).
    const res = await safeFetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) return { orderedItems: [], totalItems: 0 };
    const data = await res.json();
    const items = data?.orderedItems || data?.items || [];
    return { orderedItems: items, totalItems: data?.totalItems ?? items.length };
  } catch {
    return { orderedItems: [], totalItems: 0 };
  } finally {
    clearTimeout(timer);
  }
}

export default route(async ({ req, params, query, user, set, setStatus }) => {
  const userId = decodeURIComponent(params.id);

  // Remote user: proxy live, no local visibility/folder logic applies (the
  // remote server enforces its own).
  const { domain: userDomain } = kowloonId(userId);
  if (userDomain && !isLocalDomain(userDomain)) {
    const { orderedItems, totalItems } = await fetchRemoteBookmarks(userId, userDomain, query);
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(Math.max(1, parseInt(query.limit, 10) || 20), 100);
    const domain = getSetting("domain");
    const protocol = req.headers["x-forwarded-proto"] || "https";
    const base = `${protocol}://${domain}${req.baseUrl}`;
    const collection = activityStreamsCollection({
      id: `${base}?page=${page}`,
      orderedItems,
      totalItems,
      page,
      itemsPerPage: limit,
      baseUrl: base,
    });
    for (const [k, v] of Object.entries(collection)) set(k, v);
    return;
  }

  const viewerId = user?.id || null;
  const isOwner = !!viewerId && viewerId === userId;
  const ctx = await getViewerContext(viewerId);

  // SECURITY: coerce to plain strings before these reach a Mongo filter --
  // `?parentFolder[$ne]=x` / `?type[$regex]=` would otherwise be operator
  // objects (also stripped globally by routes/middleware/sanitizeQuery.js;
  // this is belt-and-braces for arrays and any future parser change).
  const asStr = (v) => (Array.isArray(v) ? asStr(v[0]) : typeof v === "string" ? v : undefined);
  const parentFolder = asStr(query.parentFolder);
  const typeParam = asStr(query.type);
  const wantsFolderContents = parentFolder && parentFolder !== "root";

  // Walking *into* a folder requires the whole ancestor chain to be visible —
  // otherwise we'd leak children that nominally have a wider `to`. Owner
  // skips this since they can always see their own folders.
  if (wantsFolderContents && !isOwner) {
    const visible = await canSeeFolderChain(parentFolder, ctx);
    if (!visible) {
      setStatus(404);
      set("error", "Not found");
      return;
    }
  }

  const visibilityFilter = isOwner ? { deletedAt: null } : buildVisibilityQuery(ctx);

  const scoping = { actorId: userId, deletedAt: null };
  if (typeParam) scoping.type = String(typeParam);
  if (wantsFolderContents) {
    scoping.parentFolder = String(parentFolder);
  } else if (parentFolder === "root" || !isOwner) {
    // Explicit root request OR a non-owner — never leak descendants here.
    scoping.parentFolder = { $in: [null, undefined] };
  }
  // else: owner with parentFolder omitted → flat-all (no parentFolder clause)

  const filter = { $and: [visibilityFilter, scoping] };

  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(Math.max(1, parseInt(query.limit, 10) || 20), 100);
  const skip = (page - 1) * limit;

  const [docs, total] = await Promise.all([
    Bookmark.find(filter)
      .select(SELECT)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Bookmark.countDocuments(filter),
  ]);

  const domain = getSetting("domain");
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const base = `${protocol}://${domain}${req.baseUrl}`;

  const collection = activityStreamsCollection({
    id: `${base}?page=${page}`,
    orderedItems: docs,
    totalItems: total,
    page,
    itemsPerPage: limit,
    baseUrl: base,
  });

  for (const [k, v] of Object.entries(collection)) set(k, v);
});
