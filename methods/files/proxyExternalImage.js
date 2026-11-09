// proxyExternalImage — download an external image URL and store it as a File record.
// Used to cache og:image URLs from Link posts so they don't break if the source moves.
// Returns the new file: ID on success, undefined on failure (always non-fatal).

import { getStorageAdapter } from './StorageManager.js';
import { validateUpload } from './validateUpload.js';
import { isSafeUrl, safeFetch } from '#methods/utils/safeUrl.js';
import File from '#schema/File.js';
import { Post, FeedItems } from '#schema';
import getSettings from '#methods/settings/get.js';

const TIMEOUT_MS = 10_000;
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export default async function proxyExternalImage({ url, actorId, postId }) {
  try {
    if (!url || !url.startsWith('http')) return;

    if (!await isSafeUrl(url)) {
      console.warn(`[proxyExternalImage] Blocked SSRF attempt: ${url}`);
      return;
    }

    const settings = await getSettings();
    const domain = settings?.domain || process.env.DOMAIN || 'localhost';

    // SECURITY: safeFetch re-checks the SSRF guard on every redirect hop
    // (fetch's redirect:'follow' only had the first URL checked above) and
    // its timeout also covers reading the body.
    let res;
    try {
      res = await safeFetch(url, {
        timeout: TIMEOUT_MS,
        headers: { 'User-Agent': 'kowloon/1.0 (+image-proxy)' },
      });
    } catch {
      return;
    }

    if (!res.ok) return;

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) return;

    // Guard against oversized images
    const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_SIZE_BYTES) return;

    const rawBuffer = Buffer.from(await res.arrayBuffer());
    if (!rawBuffer.length || rawBuffer.length > MAX_SIZE_BYTES) return;

    // Validate MIME type, verify magic bytes, sanitize SVGs, re-encode raster images
    let buffer, mimeType;
    try {
      ({ buffer, mimeType } = await validateUpload(rawBuffer, contentType));
    } catch (err) {
      console.warn(`[proxyExternalImage] Rejected ${url}: ${err.message}`);
      return;
    }

    // Derive a filename from the URL path
    let originalFileName = 'image.jpg';
    try {
      const p = new URL(url).pathname;
      const last = p.split('/').pop();
      if (last && last.includes('.')) originalFileName = last;
    } catch {}

    // Upload to storage
    const storage = await getStorageAdapter();
    const result = await storage.upload(buffer, {
      originalFileName,
      actorId,
      contentType: mimeType,
      generateThumbnail: true,
      thumbnailSizes: [200, 400],
      isPublic: false,
    });

    // Map thumbnail storage keys (same pattern as the file upload route)
    let thumbnails = null;
    if (result.thumbnails) {
      thumbnails = {};
      for (const [size] of Object.entries(result.thumbnails)) {
        thumbnails[size] = `thumbnails/${result.key.replace(/\.[^.]+$/, '')}_${size}.webp`;
      }
    }

    // Create the File record
    const file = new File({
      actorId,
      to: '@public',
      parentObject: postId,
      originalFileName,
      name: originalFileName,
      type: 'Image',
      mediaType: result.metadata?.contentType || contentType,
      extension: originalFileName.split('.').pop()?.toLowerCase(),
      url: 'pending',
      size: result.metadata?.size,
      width: result.metadata?.width,
      height: result.metadata?.height,
      storageKey: result.key,
      thumbnails,
    });

    await file.save(); // pre-save sets file.id = file:<_id>@domain
    file.url = `https://${domain}/files/${file.id}`;
    await file.save();

    // Patch the Post and FeedItems with the canonical file: ID
    await Post.updateOne({ id: postId }, { $set: { image: file.id } });
    await FeedItems.updateOne({ id: postId }, { $set: { 'object.image': file.id } });

    return file.id;
  } catch (err) {
    // Non-fatal — a failed proxy must never break post creation
    console.error(`[proxyExternalImage] Failed to proxy ${url}:`, err.message);
  }
}
