// /routes/files/serve.js
// Authenticated file proxy. Resolves visibility from the file's parent object,
// then streams the bytes through the app from internal object storage. Keeping
// storage private means a file's only public URL is this endpoint
// (https://<domain>/files/:id) — already TLS-terminated by the reverse proxy
// and reachable by federation peers, with no presigned URLs or public storage
// surface to provision. This is the "authenticated proxy" the architecture docs
// describe.
//
// GET /files/:id          — stream the file
// GET /files/:id?size=200 — stream the thumbnail variant
//
// Auth: Bearer token in Authorization header OR ?token= query param (legacy).
// The actual access decision (signed-URL grant / signed S2S peer / JWT
// viewer) lives in methods/files/authorizeFileAccess.js — shared with
// routes/files/get.js so the two can't drift (see that file's header and
// issue #45).

import kowloonId from '#methods/parse/kowloonId.js';
import File from '#schema/File.js';
import { getStorageAdapter } from '#methods/files/index.js';
import isLocalDomain from '#methods/parse/isLocalDomain.js';
import { hydrateRemoteFile } from '#methods/files/hydrateRemoteFile.js';
import { authorizeFileAccess, normalizeVisibility } from '#methods/files/authorizeFileAccess.js';

export default async function serve(req, res) {
  const fileId = req.params.id;
  const sizeParam = req.query.size ? String(req.query.size) : null;

  if (!fileId) return res.status(400).json({ error: 'File id is required' });

  try {
    const file = await File.findOne({ id: fileId, deletedAt: null }).lean();
    if (!file) return res.status(404).json({ error: 'File not found' });

    const auth = await authorizeFileAccess(file, req);
    if (!auth.allowed) {
      return res.status(auth.identified ? 403 : 401).json({
        error: auth.identified ? 'Access denied' : 'Authentication required',
      });
    }
    const { effectiveTo, parentIsRemote } = auth;

    let storageKey = file.storageKey;
    if (sizeParam) {
      // Prefer the requested thumbnail; gracefully fall back to the original
      // so older files without thumbnails still serve when callers request a
      // size variant.
      const thumbKey = file.thumbnails?.[sizeParam];
      if (thumbKey) storageKey = thumbKey;
    }

    // Remote-cached shadow File with no bytes yet (cache miss, or hydration
    // hasn't run for this fileId) — self-heal by fetching+caching inline
    // instead of 404ing. hydrateRemoteFile signs its outbound request, so
    // this works for restricted remote files too (the origin authorizes us
    // by domain — see authorizeFileAccess.js and issue #57); it degrades to a
    // no-op 404 only if the origin actually denies us. Origin is derived
    // from the id itself (not a stored field — reliable and matches how
    // hydrateRemoteFile.js determines it internally).
    if (!storageKey) {
      const parsedId = kowloonId(fileId);
      if (parsedId?.domain && !isLocalDomain(parsedId.domain)) {
        const hydrated = await hydrateRemoteFile(fileId);
        if (hydrated?.storageKey) storageKey = hydrated.storageKey;
      }
    }

    if (!storageKey) return res.status(404).json({ error: 'File has no storage key' });

    const storage = await getStorageAdapter();

    const exists = await storage.exists(storageKey);
    if (!exists) return res.status(404).json({ error: 'File not found in storage' });

    // LRU signal for remote-cache expiry (methods/gc/index.js, issue #55) —
    // only meaningful for a file we don't originate ourselves; a real local
    // upload never expires regardless of this field, so skip the write for
    // those (the vast majority of traffic). Fire-and-forget: never block
    // serving bytes on it.
    const fileDomain = kowloonId(fileId)?.domain;
    if (fileDomain && !isLocalDomain(fileDomain)) {
      File.updateOne({ id: fileId }, { $set: { lastViewed: new Date() } }).catch(() => {});
    }

    // Thumbnails are generated as webp; originals carry their own mediaType.
    const isThumb = !!(sizeParam && file.thumbnails?.[sizeParam]);
    const contentType = isThumb
      ? 'image/webp'
      : file.mediaType || 'application/octet-stream';

    // effectiveTo/file.to isn't a reliable public/private signal for a
    // remote-parented file (the origin's own File.to is almost always
    // "@public" regardless of the real post restriction, same convention
    // used locally) — stay conservative rather than query FeedItems again
    // just for a cache header.
    const cacheControl = !parentIsRemote && normalizeVisibility(effectiveTo) === '@public'
      ? 'public, max-age=300'
      : 'private, max-age=60'

    const isMedia = !isThumb && (file.type === 'Video' || file.type === 'Audio')
    const rangeHeader = req.headers.range

    // Range requests — required for video seeking and iOS Safari playback.
    if (isMedia && rangeHeader && typeof file.size === 'number' && file.size > 0) {
      const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/)
      if (match) {
        const start = match[1] ? parseInt(match[1], 10) : 0
        const end   = match[2] ? parseInt(match[2], 10) : file.size - 1
        const safeEnd = Math.min(end, file.size - 1)
        const chunkSize = safeEnd - start + 1

        res.setHeader('Content-Type', contentType)
        res.setHeader('Content-Range', `bytes ${start}-${safeEnd}/${file.size}`)
        res.setHeader('Content-Length', String(chunkSize))
        res.setHeader('Accept-Ranges', 'bytes')
        res.setHeader('Cache-Control', cacheControl)
        res.status(206)

        const stream = await storage.getStream(storageKey, `bytes=${start}-${safeEnd}`)
        stream.on('error', (err) => {
          console.error('[files/serve] range stream error:', err)
          if (!res.headersSent) res.status(500).json({ error: 'Failed to read file' })
          else res.destroy(err)
        })
        res.on('close', () => stream.destroy?.())
        return stream.pipe(res)
      }
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', cacheControl);
    if (isMedia) res.setHeader('Accept-Ranges', 'bytes')
    if (!isThumb && typeof file.size === 'number') {
      res.setHeader('Content-Length', String(file.size));
    }

    const stream = await storage.getStream(storageKey);
    stream.on('error', (err) => {
      console.error('[files/serve] stream error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to read file' });
      else res.destroy(err);
    });
    // If the client disconnects mid-stream, stop pulling from storage.
    res.on('close', () => stream.destroy?.());
    return stream.pipe(res);
  } catch (err) {
    console.error('[files/serve] Error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Failed to serve file' });
  }
}
