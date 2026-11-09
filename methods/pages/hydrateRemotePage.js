// Cache a remote Kowloon page locally so the app can view it in-app instead of
// bouncing to the browser (issue #74). Mirrors hydrateRemoteFile: fetch the
// origin's own public GET /pages/:slug (which returns JSON to API clients) and
// upsert a local Page *shadow* with originDomain = the source domain.
//
// PUBLIC pages only. SSRF guard: we only ever fetch a host that's already in our
// FederatedServer cache (a server we know is Kowloon) — never an arbitrary
// user-supplied host.

import { Page, FederatedServer } from "#schema";
import isLocalDomain from "#methods/parse/isLocalDomain.js";
import { safeFetch } from "#methods/utils/safeUrl.js";
import { sanitizeRemoteHtml } from "#methods/utils/sanitizeRemote.js";

const FRESH_MS = 24 * 60 * 60 * 1000; // re-fetch a shadow at most daily

function isPublicTo(to) {
  return !to || to === "@public" || to === "public";
}

// Returns the cached Page doc (lean) or null. Never throws.
export async function hydrateRemotePage(domain, slug, { fetcher = safeFetch } = {}) {
  if (!domain || !slug || isLocalDomain(domain)) return null;

  // SSRF guard — only hydrate from servers we already know are Kowloon.
  const known = await FederatedServer.findOne({ domain }).lean();
  if (!known) return null;

  const existing = await Page.findOne({
    slug,
    originDomain: domain,
    deletedAt: null,
  }).lean();
  if (
    existing?.updatedAt &&
    Date.now() - new Date(existing.updatedAt).getTime() < FRESH_MS
  ) {
    return existing;
  }

  let data;
  try {
    const res = await fetcher(
      `https://${domain}/pages/${encodeURIComponent(slug)}`,
      { headers: { accept: "application/json" } }
    );
    if (!res.ok) return existing || null;
    const body = await res.json();
    data = body?.item || body?.page || body;
  } catch {
    return existing || null;
  }
  if (!data || !data.id || !isPublicTo(data.to)) return existing || null;

  // SECURITY (2026-11-09): the shadow is upserted by id, so the remote may
  // only describe a page on ITS OWN domain -- otherwise it could overwrite
  // one of our local pages. Same rule as federation pulls.
  const ownsId = (id) =>
    typeof id === "string" &&
    id.slice(id.lastIndexOf("@") + 1).toLowerCase() === String(domain).toLowerCase();
  if (!ownsId(data.id) || (data.actorId && !ownsId(data.actorId))) return existing || null;

  const doc = {
    id: data.id,
    objectType: "Page",
    type: data.type === "Folder" ? "Folder" : "Page",
    title: data.title || slug,
    slug: data.slug || slug,
    // Never trust a peer's HTML: re-sanitize locally (see sanitizeRemote.js).
    summary: data.summary ? sanitizeRemoteHtml(data.summary) : undefined,
    body: sanitizeRemoteHtml(data.body || ""),
    source: data.source || undefined,
    actorId: data.actorId,
    actor: data.actor,
    server: data.server || `@${domain}`,
    url: data.url || `https://${domain}/pages/${encodeURIComponent(slug)}`,
    to: data.to || "@public",
    originDomain: domain,
  };

  try {
    return await Page.findOneAndUpdate(
      { id: data.id },
      { $set: doc },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
  } catch {
    return existing || null;
  }
}

export default hydrateRemotePage;
