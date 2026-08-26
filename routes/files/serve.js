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

import { jwtVerify, importSPKI } from 'jose';
import kowloonId from '#methods/parse/kowloonId.js';
import File from '#schema/File.js';
import { getStorageAdapter } from '#methods/files/index.js';
import { verifyFileSig } from '#methods/files/signedUrl.js';
import { getViewerContext } from '#methods/visibility/context.js';
import getSettings from '#methods/settings/get.js';
import { Post, Reply, User, Group, Page, Bookmark, Circle } from '#schema';
import isLocalDomain from '#methods/parse/isLocalDomain.js';
import { hydrateRemoteFile } from '#methods/files/hydrateRemoteFile.js';

const PARENT_MODELS = { Post, Reply, User, Group, Page, Bookmark, Circle };

async function getParentTo(parentId) {
  if (!parentId) return null;
  const parsed = kowloonId(parentId);
  if (!parsed?.type) return null;
  if (parsed.type === 'User') {
    const user = await User.findOne({ id: parentId, deletedAt: null }).select('to actorId').lean();
    return user?.to ?? null;
  }
  const Model = PARENT_MODELS[parsed.type];
  if (!Model) return null;
  const doc = await Model.findOne({ id: parentId, deletedAt: null }).select('to actorId').lean();
  return doc?.to ?? null;
}

function extractToken(req) {
  const auth = req.headers?.authorization || '';
  const m = auth.match(/^(?:Bearer|Token|JWT)\s+(.+)$/i);
  if (m?.[1]) return m[1].trim();
  if (auth && !/\s/.test(auth)) return auth.trim();
  return req.query?.token || '';
}

async function resolveViewer(token) {
  if (!token) return null;
  try {
    const settings = await getSettings();
    const pub = (settings?.publicKey || '').replace(/\\n/g, '\n').trim();
    if (!pub) return null;
    const domain = settings?.domain || process.env.DOMAIN;
    const issuer = domain ? `https://${domain}` : undefined;
    const key = await importSPKI(pub, 'RS256');
    const { payload } = await jwtVerify(token, key, issuer ? { issuer } : {});
    return payload?.user?.id || null;
  } catch {
    return null;
  }
}

function normalizeVisibility(to) {
  if (!to) return '@public';
  const v = String(to).trim().toLowerCase();
  if (v === 'public' || v === '@public') return '@public';
  return to;
}

async function canAccess(to, file, viewerId) {
  const visibility = normalizeVisibility(to);
  if (visibility === '@public') return true;
  if (!viewerId) return false;
  if (file.actorId === viewerId) return true;
  const ctx = await getViewerContext(viewerId);
  if (visibility.startsWith('@')) return ctx.viewerDomain === visibility.slice(1);
  if (visibility === viewerId) return true;
  return ctx.circleIds.has(visibility) || ctx.groupIds.has(visibility);
}

export default async function serve(req, res) {
  const fileId = req.params.id;
  const sizeParam = req.query.size ? String(req.query.size) : null;

  if (!fileId) return res.status(400).json({ error: 'File id is required' });

  try {
    const file = await File.findOne({ id: fileId, deletedAt: null }).lean();
    if (!file) return res.status(404).json({ error: 'File not found' });

    const parentTo = file.parentObject ? await getParentTo(file.parentObject) : null;
    const effectiveTo = parentTo ?? file.to ?? '@public';

    // A valid app-issued signature grants access to this one file (the API only
    // mints them for viewers it already authorized). Otherwise fall back to the
    // Bearer/?token JWT + parent-visibility check.
    if (!verifyFileSig(fileId, req.query.exp, req.query.sig)) {
      const token = extractToken(req);
      const viewerId = await resolveViewer(token);
      const allowed = await canAccess(effectiveTo, file, viewerId);

      if (!allowed) {
        return res.status(viewerId ? 403 : 401).json({
          error: viewerId ? 'Access denied' : 'Authentication required',
        });
      }
    }

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
    // instead of 404ing. Public remote files only for now (see issue #57);
    // still a no-op 404 for restricted remote files, same as before. Origin
    // is derived from the id itself (not a stored field — reliable and
    // matches how hydrateRemoteFile.js determines it internally).
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

    // Thumbnails are generated as webp; originals carry their own mediaType.
    const isThumb = !!(sizeParam && file.thumbnails?.[sizeParam]);
    const contentType = isThumb
      ? 'image/webp'
      : file.mediaType || 'application/octet-stream';

    const cacheControl = normalizeVisibility(effectiveTo) === '@public'
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
