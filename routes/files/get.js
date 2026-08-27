// /routes/files/get.js
// GET /files/:id/meta - Retrieve file metadata
//
// Auth mirrors routes/files/serve.js exactly, via the shared
// methods/files/authorizeFileAccess.js — metadata visibility must match
// content visibility (issue #45: this route used to have no auth check at
// all, and would mint a working signed URL for a restricted file's bytes to
// anyone who knew the id).

import route from '../utils/route.js';
import File from '#schema/File.js';
import { buildFileUrl } from '#methods/files/signedUrl.js';
import { getSetting } from '#methods/settings/cache.js';
import { authorizeFileAccess } from '#methods/files/authorizeFileAccess.js';

export default route(async ({ req, params, query, setStatus, set }) => {
  const { id } = params;

  if (!id) {
    setStatus(400);
    set('error', 'File id is required');
    return;
  }

  try {
    const file = await File.findOne({ id, deletedAt: null }).lean();

    if (!file) {
      setStatus(404);
      set('error', 'File not found');
      return;
    }

    const auth = await authorizeFileAccess(file, req);
    if (!auth.allowed) {
      setStatus(auth.identified ? 403 : 401);
      set('error', auth.identified ? 'Access denied' : 'Authentication required');
      return;
    }

    // If a ready-to-use URL is requested, return an app-served signed URL
    // (works for both public and restricted files for its TTL). Minting one
    // only makes sense for a genuinely authenticated local viewer — an S2S
    // peer can just sign its own request to /files/:id directly, and a
    // minted URL is a bearer credential it has no reason to hold.
    if (query.signed === 'true' || query.signed === '1') {
      if (!auth.viewerId) {
        setStatus(403);
        set('error', 'Signed URL minting requires an authenticated local viewer');
        return;
      }

      const expiresIn = parseInt(query.expiresIn || '3600', 10);
      const protocol = req.headers['x-forwarded-proto'] || 'https';
      const signedUrl = buildFileUrl({
        fileId: file.id,
        domain: getSetting('domain'),
        protocol,
        restricted: true,
        ttlSeconds: expiresIn,
      });

      setStatus(200);
      set('file', file);
      set('signedUrl', signedUrl);
      return;
    }

    setStatus(200);
    set('file', file);
  } catch (error) {
    console.error('[files/get] Error:', error);
    setStatus(500);
    set('error', error.message || 'Failed to retrieve file');
  }
});
