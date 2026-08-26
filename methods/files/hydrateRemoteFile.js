// Cache a remote file's metadata AND bytes locally, so our own /files/:id
// proxy can serve it directly instead of clients fetching the origin server
// (see routes/files/serve.js's header comment: storage is private, our own
// proxy is the only public URL — this closes the gap where remote media was
// the one exception).
//
// Cross-server posts reference their media as `file:<id>@<remote-domain>`. The
// receiving server has no File record for those ids, so attachment enrichment
// dropped them entirely — every federated post with an image / audio / video
// showed no media (#71). This fetches the origin's public `/files/:id/meta`,
// upserts a local File shadow, and — once, per file — fetches the actual
// bytes and stores them locally under a `remote-cache/` key prefix (kept
// separate from real uploads so the GC worker can expire stale cache entries
// without ever touching user-uploaded content; see methods/gc/index.js).
//
// PUBLIC files only. The origin's /meta and bytes are anonymous-fetchable
// just for `@public` files. Restricted remote media needs real cross-server
// request authorization (reusing the HTTP-signature federation auth already
// built for inbox delivery) before this can safely extend to non-public
// content — see issue #57. Until then this behaves the same as before for
// restricted files: skip, leave the bare id (dropped downstream, no
// regression).

import { File } from "#schema";
import kowloonId from "#methods/parse/kowloonId.js";
import isLocalDomain from "#methods/parse/isLocalDomain.js";
import { isPublicVisibility } from "#methods/files/signedUrl.js";
import { getStorageAdapter } from "#methods/files/index.js";

const FRESH_MS = 24 * 60 * 60 * 1000; // re-fetch a shadow's meta at most daily
const REMOTE_CACHE_PREFIX = "remote-cache";

// Fetch a remote file's bytes and store them locally. Returns the new
// storageKey, or null on any failure (non-fatal — retried on next hydration,
// or self-healed via serve.js's lazy fallback).
async function fetchAndStoreBytes({ fileId, url, mediaType, extension, actorId }, fetcher) {
  if (!url) return null;
  try {
    const res = await fetcher(url);
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
      const res = await fetcher(
        `https://${domain}/files/${encodeURIComponent(fileId)}/meta`,
        { headers: { accept: "application/json" } }
      );
      if (!res.ok) return existing || null;
      const body = await res.json();
      meta = body?.file || body?.item || body;
    } catch {
      return existing || null;
    }
    // Public files only. The origin reports visibility as "@public", "public", or
    // empty depending on the code path — accept them all (a strict === "@public"
    // check skipped bare-"public" images, so remote Media images never cached, #71).
    if (!meta || !isPublicVisibility(meta.to)) return existing || null;

    doc = {
      id: fileId,
      actorId: meta.actorId || `@${domain}`,
      name: meta.name || meta.originalFileName || "",
      summary: meta.summary || "",
      type: meta.type || "",
      mediaType: meta.mediaType || "",
      extension: meta.extension || "",
      to: "@public",
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
