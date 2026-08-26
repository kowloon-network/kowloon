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
import { Post, Reply, User, Group, Page, Bookmark, Circle, FeedItems } from '#schema';
import isLocalDomain from '#methods/parse/isLocalDomain.js';
import { hydrateRemoteFile } from '#methods/files/hydrateRemoteFile.js';
import verifyHttpSignature from '#methods/federation/verifyHttpSignature.js';
import { domainHasAudienceMember } from '#methods/visibility/domainHasAudienceMember.js';
import { canView } from '#methods/feed/visibility.js';

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

// Local-viewer gating for a file whose parent is a REMOTE (federated) post —
// a different mechanism than canAccess() above. Kowloon never discloses a
// restricted post's real circle id across servers (FeedItems.to is only ever
// the coarse public/server/audience enum), so there's no circle id to check
// membership against here. What we actually receive for restricted content is
// a set of per-*local*-user grants (FeedFanOut) computed at pull time — the
// same mechanism the feed itself already uses for federated audience posts.
// Reuses canView() (methods/feed/visibility.js) directly rather than
// re-deriving the same public/server/audience logic a second time.
async function canAccessRemoteParent(parentId, viewerId) {
  // canView() reads feedCacheItem.id (for the FeedFanOut lookup) in
  // addition to `to`/`actorId` — must select it too.
  const feedItem = await FeedItems.findOne({ id: parentId }).select('id to actorId').lean();
  if (!feedItem) return false;
  return canView(feedItem, viewerId);
}

export default async function serve(req, res) {
  const fileId = req.params.id;
  const sizeParam = req.query.size ? String(req.query.size) : null;

  if (!fileId) return res.status(400).json({ error: 'File id is required' });

  try {
    const file = await File.findOne({ id: fileId, deletedAt: null }).lean();
    if (!file) return res.status(404).json({ error: 'File not found' });

    // A parent living on another domain is a cached remote-origin file (see
    // methods/files/hydrateRemoteFile.js) — its local viewer gating goes
    // through canAccessRemoteParent() instead of the circle/group-based
    // canAccess() below, since we never have a real circle id for it (see
    // that function's comment). getParentTo() would just miss for these
    // (no local Post/Reply/etc record exists for a remote id) — skip it.
    const parsedParent = file.parentObject ? kowloonId(file.parentObject) : null;
    const parentIsRemote = !!(parsedParent?.domain && !isLocalDomain(parsedParent.domain));

    const parentTo = !parentIsRemote && file.parentObject ? await getParentTo(file.parentObject) : null;
    const effectiveTo = parentTo ?? file.to ?? '@public';

    // A valid app-issued signature grants access to this one file (the API only
    // mints them for viewers it already authorized). Otherwise: a signed S2S
    // request from a peer Kowloon server is authorized by DOMAIN, not by local
    // viewer identity — does the audience this file is restricted to have any
    // member on the signing server's domain? (See issue #57 — this is what
    // lets a peer legitimately cache our restricted media instead of only
    // ever being able to fetch @public bytes.) Only meaningful for content WE
    // originate (real circle data); doesn't apply to a file we ourselves only
    // have a cached copy of. Otherwise fall back to the Bearer/?token JWT +
    // parent-visibility check.
    if (!verifyFileSig(fileId, req.query.exp, req.query.sig)) {
      let allowed = false;
      let viewerId = null;
      let identified = false; // did we identify SOME requester (local viewer or a validly-signed peer), even if not authorized — governs 401 vs 403 below

      if (!parentIsRemote && req.get('Signature')) {
        const sig = await verifyHttpSignature(req);
        // sig.domain is derived from the request's own Host header — i.e.
        // OUR domain, since we're the receiver, not the signer's identity.
        // The signer's actual domain is embedded in the (now cryptographically
        // validated) keyId URL, same as routes/inbox/post.js's domain-
        // consistency check already relies on.
        if (sig.ok) {
          identified = true;
          const signerDomain = kowloonId(sig.keyId)?.domain;
          allowed = await domainHasAudienceMember(effectiveTo, signerDomain);
        }
      }

      if (!allowed) {
        const token = extractToken(req);
        viewerId = await resolveViewer(token);
        if (viewerId) identified = true;
        allowed = parentIsRemote
          ? await canAccessRemoteParent(file.parentObject, viewerId)
          : await canAccess(effectiveTo, file, viewerId);
      }

      if (!allowed) {
        return res.status(identified ? 403 : 401).json({
          error: identified ? 'Access denied' : 'Authentication required',
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
    // instead of 404ing. hydrateRemoteFile signs its outbound request, so
    // this works for restricted remote files too (the origin authorizes us
    // by domain — see the S2S branch above and issue #57); it degrades to a
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
