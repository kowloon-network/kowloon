// /routes/files/upload.js
// Handle file uploads via multipart/form-data

import route from '../utils/route.js';
import { getStorageAdapter } from '#methods/files/index.js';
import { validateUpload } from '#methods/files/validateUpload.js';
import File from '#schema/File.js';
import MediaJob from '#schema/MediaJob.js';
import { canonicalTo } from '#methods/parse/canonicalTo.js';
import isServerAdmin from '#methods/auth/isServerAdmin.js';
import getSettings from '#methods/settings/get.js';

const MAX_IMAGE_DIMENSION = 2048
// Video types that need async faststart processing
const NEEDS_MEDIA_JOB = new Set(['video/mp4', 'video/quicktime', 'video/x-m4v'])

export default route(
  async ({ req, body, user, setStatus, set }) => {
    if (req.multerError) {
      setStatus(413);
      set('error', req.multerError.message || 'File too large');
      return;
    }

    if (!req.file) {
      setStatus(400);
      set('error', 'No file uploaded');
      return;
    }

    const { originalname: originalFileName, mimetype } = req.file;
    let { buffer } = req.file;
    const { title, summary, thumbnailSizes, parentObject } = body;
    // Default to generating thumbnails; allow opting out by sending "false".
    // The S3Adapter will skip non-image MIME types regardless.
    const generateThumbnail = body.generateThumbnail === 'false' || body.generateThumbnail === false
      ? false
      : true;

    // Validate MIME type against allowlist, verify magic bytes, sanitize SVGs,
    // and re-encode raster images to strip embedded payloads.
    let mimeType;
    try {
      ({ buffer, mimeType } = await validateUpload(buffer, mimetype));
    } catch (err) {
      setStatus(415);
      set('error', err.message);
      return;
    }

    // Cap raster images to MAX_IMAGE_DIMENSION on the long edge.
    // GIFs and SVGs are excluded — sharp doesn't preserve GIF animation,
    // and SVGs are vector so dimension capping doesn't apply.
    if (mimeType.startsWith('image/') && mimeType !== 'image/svg+xml' && mimeType !== 'image/gif') {
      try {
        const { default: sharp } = await import('sharp')
        const meta = await sharp(buffer).metadata()
        const longEdge = Math.max(meta.width || 0, meta.height || 0)
        // Bake in EXIF orientation whenever the image carries one — iPhone photos
        // are stored sideways with an Orientation tag. Browsers usually honor it
        // for <img>, but canvas, CSS backgrounds, the mobile app, and federated
        // servers do not, so the image shows rotated there. Normalize the pixels
        // and drop the tag at the source (this also strips EXIF GPS — a privacy win).
        const needsOrient = (meta.orientation ?? 1) > 1
        const needsResize = longEdge > MAX_IMAGE_DIMENSION
        if (needsOrient || needsResize) {
          let pipeline = sharp(buffer).rotate() // auto-orient from EXIF, then strip it
          if (needsResize) {
            // fit:'inside' caps the long edge correctly regardless of post-rotation orientation.
            pipeline = pipeline.resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, {
              fit: 'inside',
              withoutEnlargement: true,
            })
          }
          buffer = await pipeline.toBuffer()
        }
      } catch (err) {
        console.warn('[files/upload] Image normalize/resize failed, using original:', err.message)
      }
    }

    // Admins may specify an explicit actorId; otherwise use auth user
    let actorId = user.id;
    if (body.actorId && body.actorId !== user.id) {
      const admin = await isServerAdmin(user.id);
      if (!admin) {
        setStatus(403);
        set('error', 'Only admins may upload on behalf of another actor');
        return;
      }
      actorId = body.actorId;
    }

    try {
      const storage = await getStorageAdapter();

      // Always store private in the backend — visibility enforced by the proxy
      const result = await storage.upload(buffer, {
        originalFileName,
        actorId,
        title,
        summary,
        contentType: mimeType,
        generateThumbnail,
        thumbnailSizes: thumbnailSizes ? JSON.parse(thumbnailSizes) : [200, 400],
        isPublic: false,
      });

      // Store thumbnail storage keys (not URLs) — proxy builds URLs at serve time
      let thumbnails = null;
      if (result.thumbnails) {
        thumbnails = {};
        for (const [size] of Object.entries(result.thumbnails)) {
          thumbnails[size] = `thumbnails/${result.key.replace(/\.[^.]+$/, '')}_${size}.webp`;
        }
      }

      // Create the File record first so we get the canonical file.id from the pre-save hook
      const settings = await getSettings();
      const domain = settings?.domain || process.env.DOMAIN || 'localhost';

      const needsJob = NEEDS_MEDIA_JOB.has(mimeType)

      const file = new File({
        actorId,
        // If parentObject is provided, visibility is inherited from it at serve time.
        // Normalize to the canonical scheme so bare "public" etc. don't slip in
        // (they broke cross-server media caching — #71). Empty → @public.
        to: canonicalTo(body.to),
        parentObject: typeof parentObject === 'string' && parentObject.trim()
          ? parentObject.trim()
          : undefined,
        originalFileName,
        // Deliberately no fallback to originalFileName here — a bare filename
        // ("IMG_4213.jpg") isn't a caption anyone wants shown as a title; the
        // original name is already preserved above for anything that needs it
        // (e.g. download-as). Leave name blank when the uploader didn't type one.
        name: title || "",
        summary,
        type: getFileType(mimeType),
        mediaType: result.metadata.contentType,
        extension: originalFileName.split('.').pop()?.toLowerCase(),
        url: 'pending', // filled in below once we have the id
        size: result.metadata.size,
        width: result.metadata.width,
        height: result.metadata.height,
        storageKey: result.key,
        thumbnails,
        processingStatus: needsJob ? 'pending' : 'ready',
      });

      await file.save(); // pre-save hook sets file.id = file:<_id>@domain

      // Build the canonical app-proxied URL. Honors X-Forwarded-Proto (Caddy /
      // nginx in front of the app) and the actual request Host so dev URLs land
      // at http://kwln.org:3000/... while prod URLs are https://kwln.org/...
      const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
      const host  = req.headers['x-forwarded-host'] || req.headers.host || domain;
      const baseUrl = `${proto}://${host}`;
      file.url = `${baseUrl}/files/${file.id}`;
      await file.save();

      // Build thumbnail response URLs (same pattern: /files/<id>?size=<n>)
      const thumbnailUrls = thumbnails
        ? Object.fromEntries(
            Object.keys(thumbnails).map((size) => [
              size,
              `${baseUrl}/files/${file.id}?size=${size}`,
            ])
          )
        : null;

      // Enqueue async processing job for video types that need faststart
      if (needsJob) {
        await MediaJob.create({
          fileId: file.id,
          storageKey: result.key,
          mimeType,
          nextAttemptAt: new Date(),
        })
      }

      setStatus(200);
      set('file', {
        id: file.id,
        url: file.url,
        thumbnails: thumbnailUrls,
        processingStatus: file.processingStatus,
        metadata: result.metadata,
      });
    } catch (error) {
      console.error('[files/upload] Error:', error);
      setStatus(500);
      set('error', error.message || 'Failed to upload file');
    }
  },
  { allowUnauth: false }
);

function getFileType(mimeType) {
  if (!mimeType) return 'Document';
  if (mimeType.startsWith('image/')) return 'Image';
  if (mimeType.startsWith('video/')) return 'Video';
  if (mimeType.startsWith('audio/')) return 'Audio';
  return 'Document';
}
