// Cache a remote file's metadata AND bytes locally, so our own /files/:id
// proxy can serve it directly instead of clients fetching the origin server
// (see routes/files/serve.js's header comment: storage is private, our own
// proxy is the only public URL — this closes the gap where remote media was
// the one exception).
//
// Cross-server posts reference their media as `file:<id>@<remote-domain>`. The
// receiving server has no File record for those ids, so attachment enrichment
// dropped them entirely — every federated post with an image / audio / video
// showed no media (#71). This fetches (and, since issue #45, signs the
// request to) the origin's `/files/:id/meta`, upserts a local File shadow,
// and — once, per file — fetches the actual
// bytes and stores them locally under a `remote-cache/` key prefix (kept
// separate from real uploads so the GC worker can expire stale cache entries
// without ever touching user-uploaded content; see methods/gc/index.js).
//
// Bytes are fetched with a signed S2S request (methods/federation/signHttpRequest.js
// — the same HTTP-signature scheme used for inbox delivery), so this now also
// works for restricted (circle/group-only) remote media: the origin
// authorizes us by DOMAIN (does the audience have a member on our domain? —
// see methods/visibility/domainHasAudienceMember.js), not by local viewer
// identity. Once cached, WHICH of our own local viewers can see the bytes is
// gated separately by routes/files/serve.js (via methods/files/authorizeFileAccess.js's
// canAccessRemoteParent()) using FeedFanOut — see that function's comment
// for why that's a different mechanism than local files use (issue #57).

import { File } from "#schema";
import kowloonId from "#methods/parse/kowloonId.js";
import isLocalDomain from "#methods/parse/isLocalDomain.js";
import { getStorageAdapter } from "#methods/files/index.js";
import signHttpRequest from "#methods/federation/signHttpRequest.js";

const FRESH_MS = 24 * 60 * 60 * 1000; // re-fetch a shadow's meta at most daily
const REMOTE_CACHE_PREFIX = "remote-cache";

// Fetch a remote file's bytes and store them locally. Returns the new
// storageKey, or null on any failure (non-fatal — retried on next hydration,
// or self-healed via serve.js's lazy fallback).
async function fetchAndStoreBytes({ fileId, url, mediaType, extension, actorId }, fetcher) {
  if (!url) return null;
  try {
    // Signed so the origin can authorize us for restricted media by domain
    // (see routes/files/serve.js's S2S branch) — harmless/ignored by the
    // origin for public files, which don't check the signature at all.
    const { headers } = await signHttpRequest({ method: "GET", url });
    const res = await fetcher(url, { headers });
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    const storage = await getStorageAdapter();
    const safeName = fileId.replace(/[^a-zA-Z0-9]/g, "_") + (extension ? `.${extension}` : "");
    const result = await storage.upload(buffer, {
      originalFileName: safeName,
      actorId,
      contentType: mediaType || undefined,
      generateThumbnail: false,
      isPublic: false,
      prefix: REMOTE_CACHE_PREFIX,
    });
    return result.key;
  } catch {
    return null;
  }
}

// Returns the cached File doc (lean) or null. Never throws.
export async function hydrateRemoteFile(fileId, { fetcher = fetch } = {}) {
  if (typeof fileId !== "string" || !fileId.startsWith("file:")) return null;
  const parsed = kowloonId(fileId);
  const domain = parsed?.domain;
  if (!domain || isLocalDomain(domain)) return null; // local file — nothing to do

  const existing = await File.findOne({ id: fileId }).lean();
  const metaFresh =
    existing?.updatedAt && Date.now() - new Date(existing.updatedAt).getTime() < FRESH_MS;

  let doc;
  if (metaFresh) {
    // Metadata is fresh; bytes may still be missing (a prior fetch failed,
    // or this shadow predates byte-caching). Reuse cached metadata instead
    // of hammering /meta again just to retry the bytes.
    const { _id, __v, createdAt, updatedAt, ...rest } = existing;
    doc = rest;
  } else {
    let meta;
    try {
      // Signed for the same reason the bytes fetch below is: as of issue
      // #45, /meta enforces the same authorizeFileAccess() check /files/:id
      // does (it used to have none at all), so an anonymous request for a
      // RESTRICTED file's metadata would now 401 without this. Harmless for
      // public files — authorizeFileAccess() allows those regardless of how
      // the request is authenticated.
      const metaUrl = `https://${domain}/files/${encodeURIComponent(fileId)}/meta`;
      const { headers } = await signHttpRequest({ method: "GET", url: metaUrl });
      const res = await fetcher(metaUrl, { headers: { ...headers, accept: "application/json" } });
      if (!res.ok) return existing || null;
      const body = await res.json();
      meta = body?.file || body?.item || body;
    } catch {
      return existing || null;
    }
    if (!meta) return existing || null;

    doc = {
      id: fileId,
      actorId: meta.actorId || `@${domain}`,
      name: meta.name || meta.originalFileName || "",
      summary: meta.summary || "",
      type: meta.type || "",
      mediaType: meta.mediaType || "",
      extension: meta.extension || "",
      // Honest passthrough of the origin's own File.to. NOT the real
      // restriction signal for post attachments — a File's own `to` is
      // almost always "@public" regardless of its parent post's real
      // restriction (same convention locally); it's only a meaningful
      // fallback for files with no parentObject (avatars, server images).
      // Real local gating for attachment files is via parentObject below +
      // methods/files/authorizeFileAccess.js's canAccessRemoteParent().
      to: meta.to || "@public",
      // Propagated from the origin so serve.js knows which (federated) post
      // this belongs to — every attachment File reliably has this set
      // server-side (ActivityParser/handlers/Create's back-link pass), even
      // if the client never supplied it at upload time.
      parentObject: meta.parentObject || undefined,
      // The origin's own proxy URL — used to fetch bytes below; superseded
      // as the client-facing URL once storageKey is set (fileServeUrl then
      // builds a URL on OUR proxy instead).
      url: meta.url || `https://${domain}/files/${encodeURIComponent(fileId)}`,
      server: `@${domain}`,
      originDomain: domain,
      size: meta.size,
      width: meta.width,
      height: meta.height,
      storageKey: existing?.storageKey,
    };
  }

  if (!doc.storageKey) {
    const key = await fetchAndStoreBytes(
      { fileId, url: doc.url, mediaType: doc.mediaType, extension: doc.extension, actorId: doc.actorId },
      fetcher
    );
    if (key) doc.storageKey = key;
  }

  if (metaFresh && doc.storageKey === existing?.storageKey) {
    return existing; // nothing changed — metadata fresh, bytes still unavailable
  }

  try {
    return await File.findOneAndUpdate(
      { id: fileId },
      { $set: doc },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
  } catch {
    return existing || null;
  }
}

// Hydrate many ids concurrently (deduped). Silent per-item failures.
export async function hydrateRemoteFiles(fileIds, opts = {}) {
  const unique = [...new Set((fileIds || []).filter(Boolean))];
  await Promise.all(unique.map((id) => hydrateRemoteFile(id, opts).catch(() => null)));
}
