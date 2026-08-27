// methods/files/authorizeFileAccess.js
// Single source of truth for "can this request access this File" — shared by
// routes/files/serve.js (bytes) and routes/files/get.js (metadata), so the
// two can never silently drift the way they did before (issue #45: /meta had
// no auth check at all, including for ?signed=true, while /:id did).
//
// Three ways in, tried in order:
//   1. A valid app-issued signed-URL grant (?exp=&sig=) — the API only mints
//      these for viewers it already authorized elsewhere.
//   2. A signed S2S request from a peer Kowloon server, authorized by DOMAIN
//      (does the audience this file is restricted to have a member on the
//      signer's domain?) — not by local viewer identity. Lets a peer
//      legitimately cache OUR restricted media (see hydrateRemoteFile.js,
//      issue #57) instead of only ever being able to fetch @public bytes.
//   3. The Bearer/?token JWT + local-viewer visibility check — either the
//      raw circle/group `to` on a locally-owned parent (canAccess), or, for
//      a file whose parent lives on another domain, the per-local-user
//      FeedFanOut grant computed at pull time (canAccessRemoteParent) — see
//      that function's comment for why those are different mechanisms.

import { jwtVerify, importSPKI } from 'jose';
import kowloonId from '#methods/parse/kowloonId.js';
import isLocalDomain from '#methods/parse/isLocalDomain.js';
import { verifyFileSig } from '#methods/files/signedUrl.js';
import { getViewerContext } from '#methods/visibility/context.js';
import getSettings from '#methods/settings/get.js';
import { Post, Reply, User, Group, Page, Bookmark, Circle, FeedItems } from '#schema';
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

export function normalizeVisibility(to) {
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

// Which addressing value actually governs this file's visibility, and
// whether its parent lives on another server. A parent living on another
// domain is a cached remote-origin file (see hydrateRemoteFile.js) — its
// local viewer gating goes through canAccessRemoteParent() instead of the
// circle/group-based canAccess(), since we never have a real circle id for
// it. getParentTo() would just miss for these (no local Post/Reply/etc
// record exists for a remote id) — skip it.
export async function resolveFileVisibility(file) {
  const parsedParent = file.parentObject ? kowloonId(file.parentObject) : null;
  const parentIsRemote = !!(parsedParent?.domain && !isLocalDomain(parsedParent.domain));
  const parentTo = !parentIsRemote && file.parentObject ? await getParentTo(file.parentObject) : null;
  const effectiveTo = parentTo ?? file.to ?? '@public';
  return { effectiveTo, parentIsRemote };
}

// Returns { allowed, identified, viewerId, effectiveTo, parentIsRemote }.
// `identified` distinguishes "no requester identity at all" (401) from "a
// real requester — local viewer or validly-signed peer — just isn't
// authorized" (403); it's not the same as `allowed`.
export async function authorizeFileAccess(file, req) {
  const { effectiveTo, parentIsRemote } = await resolveFileVisibility(file);

  if (verifyFileSig(file.id, req.query?.exp, req.query?.sig)) {
    return { allowed: true, identified: true, viewerId: null, effectiveTo, parentIsRemote };
  }

  let allowed = false;
  let viewerId = null;
  let identified = false;

  if (!parentIsRemote && req.get('Signature')) {
    const sig = await verifyHttpSignature(req);
    // sig.domain is derived from the request's own Host header — i.e. OUR
    // domain, since we're the receiver, not the signer's identity. The
    // signer's actual domain is embedded in the (now cryptographically
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

  return { allowed, identified, viewerId, effectiveTo, parentIsRemote };
}
