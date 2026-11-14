// methods/files/validateUpload.js
// MIME type validation, allowlisting, and SVG sanitization for file uploads.

import { fileTypeFromBuffer } from 'file-type';
import sanitizeHtml from '#methods/utils/sanitize.js';
import sharp from 'sharp';
import { open, readFile } from 'fs/promises';

// ── Allowlist ─────────────────────────────────────────────────────────────────

export const ALLOWED_MIME_TYPES = new Set([
  // Images
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'image/avif', 'image/heic', 'image/heif', 'image/svg+xml',
  // Audio
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/flac',
  'audio/aac', 'audio/mp4', 'audio/webm', 'audio/opus',
  // Video
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime',
]);

// ── MIME detection ────────────────────────────────────────────────────────────

// SVGs are XML text with no magic bytes — file-type can't detect them.
// Verify by checking for an <svg element in the content.
function looksLikeSvg(buffer) {
  const text = buffer.slice(0, 4096).toString('utf8').trimStart();
  return /<svg[\s>]/i.test(text);
}

/**
 * Verify that the buffer's actual content matches the claimed MIME type.
 * Returns the resolved MIME type string, or null if verification fails.
 */
export async function detectMimeType(buffer, claimedMimeType) {
  const claimed = (claimedMimeType || '').toLowerCase().split(';')[0].trim();

  // SVG: detect by content since file-type can't read magic bytes for XML
  if (claimed === 'image/svg+xml') {
    return looksLikeSvg(buffer) ? 'image/svg+xml' : null;
  }

  // For binary formats, use magic byte detection
  const detected = await fileTypeFromBuffer(buffer);
  if (!detected) {
    // Some audio/video containers aren't detected — fall back to claimed type
    // only for known audio/video MIME types to avoid spoofing images
    if (claimed.startsWith('audio/') || claimed.startsWith('video/')) {
      return claimed;
    }
    return null;
  }

  // Allow minor MIME variants (e.g. audio/x-wav vs audio/wav)
  const detectedBase = detected.mime.split(';')[0].trim();
  if (detectedBase === claimed) return claimed;

  // Tolerate some common aliases
  const aliases = {
    'audio/x-wav':  'audio/wav',
    'audio/x-flac': 'audio/flac',
    'audio/x-m4a':  'audio/mp4',
    'video/x-matroska': 'video/webm',
  };
  const normalized = aliases[detectedBase] ?? detectedBase;
  if (normalized === claimed) return claimed;

  // If they don't match, use what we actually detected (don't trust the claim)
  return detectedBase;
}

// ── SVG sanitization ──────────────────────────────────────────────────────────

// Elements safe to keep in an SVG. Excludes:
//   <script>           — obvious
//   <foreignObject>    — embeds arbitrary HTML
//   <use>              — can load external resources via href
//   <set> / <animate>  — can set href to javascript: URLs
//   <handler>          — event handler element (SVG 1.2)
const SVG_ALLOWED_TAGS = [
  'svg', 'g', 'defs', 'title', 'desc', 'metadata', 'symbol',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath',
  'image',
  'linearGradient', 'radialGradient', 'stop',
  'clipPath', 'mask', 'pattern', 'marker',
  'filter',
  'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite',
  'feConvolveMatrix', 'feDiffuseLighting', 'feDisplacementMap',
  'feFlood', 'feGaussianBlur', 'feImage', 'feMerge', 'feMergeNode',
  'feMorphology', 'feOffset', 'feSpecularLighting', 'feTile', 'feTurbulence',
  'feFuncR', 'feFuncG', 'feFuncB', 'feFuncA',
  'feDistantLight', 'fePointLight', 'feSpotLight',
];

// Presentation and structural attributes — no on* event handlers.
const COMMON_ATTRS = [
  'id', 'class', 'style',
  'transform', 'clip-path', 'mask', 'filter', 'marker-start', 'marker-mid', 'marker-end',
  'fill', 'fill-opacity', 'fill-rule', 'clip-rule',
  'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit',
  'opacity', 'display', 'visibility', 'overflow', 'color', 'color-interpolation',
  'color-interpolation-filters', 'color-rendering',
  'font-family', 'font-size', 'font-size-adjust', 'font-stretch',
  'font-style', 'font-variant', 'font-weight', 'font',
  'text-anchor', 'text-decoration', 'text-rendering', 'dominant-baseline',
  'letter-spacing', 'word-spacing', 'writing-mode', 'direction', 'unicode-bidi',
  'shape-rendering', 'image-rendering', 'paint-order',
  'vector-effect', 'pointer-events',
];

const SVG_ALLOWED_ATTRIBUTES = {
  '*': COMMON_ATTRS,
  'svg': [...COMMON_ATTRS, 'xmlns', 'xmlns:xlink', 'viewBox', 'width', 'height',
          'version', 'baseProfile', 'preserveAspectRatio', 'x', 'y'],
  'path': [...COMMON_ATTRS, 'd'],
  'rect': [...COMMON_ATTRS, 'x', 'y', 'width', 'height', 'rx', 'ry'],
  'circle': [...COMMON_ATTRS, 'cx', 'cy', 'r'],
  'ellipse': [...COMMON_ATTRS, 'cx', 'cy', 'rx', 'ry'],
  'line': [...COMMON_ATTRS, 'x1', 'y1', 'x2', 'y2'],
  'polyline': [...COMMON_ATTRS, 'points'],
  'polygon': [...COMMON_ATTRS, 'points'],
  'text': [...COMMON_ATTRS, 'x', 'y', 'dx', 'dy', 'rotate', 'lengthAdjust', 'textLength'],
  'tspan': [...COMMON_ATTRS, 'x', 'y', 'dx', 'dy', 'rotate', 'lengthAdjust', 'textLength'],
  'textPath': [...COMMON_ATTRS, 'href', 'startOffset', 'method', 'spacing', 'textLength'],
  'image': [...COMMON_ATTRS, 'href', 'x', 'y', 'width', 'height', 'preserveAspectRatio'],
  'symbol': [...COMMON_ATTRS, 'viewBox', 'preserveAspectRatio', 'x', 'y', 'width', 'height'],
  'g': [...COMMON_ATTRS],
  'defs': [],
  'linearGradient': [...COMMON_ATTRS, 'x1', 'y1', 'x2', 'y2', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'href'],
  'radialGradient': [...COMMON_ATTRS, 'cx', 'cy', 'r', 'fx', 'fy', 'fr', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'href'],
  'stop': [...COMMON_ATTRS, 'offset', 'stop-color', 'stop-opacity'],
  'clipPath': [...COMMON_ATTRS, 'clipPathUnits'],
  'mask': [...COMMON_ATTRS, 'x', 'y', 'width', 'height', 'maskUnits', 'maskContentUnits'],
  'pattern': [...COMMON_ATTRS, 'x', 'y', 'width', 'height', 'patternUnits', 'patternContentUnits', 'patternTransform', 'preserveAspectRatio', 'viewBox', 'href'],
  'marker': [...COMMON_ATTRS, 'viewBox', 'refX', 'refY', 'markerWidth', 'markerHeight', 'orient', 'markerUnits', 'preserveAspectRatio'],
  'filter': [...COMMON_ATTRS, 'x', 'y', 'width', 'height', 'filterUnits', 'primitiveUnits'],
  'feBlend': [...COMMON_ATTRS, 'in', 'in2', 'mode', 'result'],
  'feColorMatrix': [...COMMON_ATTRS, 'in', 'type', 'values', 'result'],
  'feComposite': [...COMMON_ATTRS, 'in', 'in2', 'operator', 'k1', 'k2', 'k3', 'k4', 'result'],
  'feGaussianBlur': [...COMMON_ATTRS, 'in', 'stdDeviation', 'edgeMode', 'result'],
  'feOffset': [...COMMON_ATTRS, 'in', 'dx', 'dy', 'result'],
  'feFlood': [...COMMON_ATTRS, 'flood-color', 'flood-opacity', 'result'],
  'feMerge': [...COMMON_ATTRS, 'result'],
  'feMergeNode': [...COMMON_ATTRS, 'in'],
  'feMorphology': [...COMMON_ATTRS, 'in', 'operator', 'radius', 'result'],
  'feTile': [...COMMON_ATTRS, 'in', 'result'],
  'feTurbulence': [...COMMON_ATTRS, 'baseFrequency', 'numOctaves', 'seed', 'stitchTiles', 'type', 'result'],
  'feDisplacementMap': [...COMMON_ATTRS, 'in', 'in2', 'scale', 'xChannelSelector', 'yChannelSelector', 'result'],
  'feImage': [...COMMON_ATTRS, 'href', 'preserveAspectRatio', 'result'],
  'feComponentTransfer': [...COMMON_ATTRS, 'in', 'result'],
  'feFuncR': [...COMMON_ATTRS, 'type', 'tableValues', 'slope', 'intercept', 'amplitude', 'exponent', 'offset'],
  'feFuncG': [...COMMON_ATTRS, 'type', 'tableValues', 'slope', 'intercept', 'amplitude', 'exponent', 'offset'],
  'feFuncB': [...COMMON_ATTRS, 'type', 'tableValues', 'slope', 'intercept', 'amplitude', 'exponent', 'offset'],
  'feFuncA': [...COMMON_ATTRS, 'type', 'tableValues', 'slope', 'intercept', 'amplitude', 'exponent', 'offset'],
};

export function sanitizeSvg(buffer) {
  const svgText = buffer.toString('utf8');
  const sanitized = sanitizeHtml(svgText, {
    allowedTags: SVG_ALLOWED_TAGS,
    allowedAttributes: SVG_ALLOWED_ATTRIBUTES,
    allowedSchemes: ['http', 'https', 'data'],
    allowedSchemesByTag: {
      image: ['http', 'https', 'data'],
      feImage: ['http', 'https', 'data'],
    },
    disallowedTagsMode: 'discard',
    // Strip XML processing instructions and DTD declarations
    allowedIframeHostnames: [],
    textFilter: (text) => text,
  });
  return Buffer.from(sanitized, 'utf8');
}

// ── Re-encode images through sharp ───────────────────────────────────────────
// Decoding and re-encoding strips embedded metadata and any payload hiding
// in file structure (ICC profiles, EXIF, IPTC, etc.).

const SHARP_SUPPORTED = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
]);

export async function reencodeImage(buffer, mimeType) {
  if (!SHARP_SUPPORTED.has(mimeType)) return buffer;
  try {
    const img = sharp(buffer);
    switch (mimeType) {
      case 'image/jpeg': return await img.jpeg({ quality: 92 }).toBuffer();
      case 'image/png':  return await img.png().toBuffer();
      case 'image/gif':  return buffer; // sharp doesn't preserve animation reliably
      case 'image/webp': return await img.webp({ quality: 90 }).toBuffer();
      case 'image/avif': return await img.avif({ quality: 70 }).toBuffer();
      default: return buffer;
    }
  } catch {
    // If sharp fails, reject — better to error than pass potentially malicious data
    throw new Error(`Image re-encoding failed for ${mimeType}`);
  }
}

// libheif applies the file's rotation, so the decoded pixels are upright.
export async function heicToJpeg(buffer) {
  try {
    const { default: decode } = await import('heic-decode');
    const { width, height, data } = await decode({ buffer });
    return await sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
      raw: { width, height, channels: 4 },
    }).jpeg({ quality: 92 }).toBuffer();
  } catch (err) {
    throw new Error(`Couldn't read this HEIC image (${err.message})`);
  }
}

// ── Main validation entry point ───────────────────────────────────────────────

/**
 * Validate and sanitize an upload buffer.
 * Returns { buffer, mimeType } on success, throws on rejection.
 */
export async function validateUpload(buffer, claimedMimeType) {
  const mimeType = await detectMimeType(buffer, claimedMimeType);

  if (!mimeType || !ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new Error(`File type not allowed: ${mimeType ?? claimedMimeType}`);
  }

  let safeBuffer = buffer;

  if (mimeType === 'image/svg+xml') {
    safeBuffer = sanitizeSvg(buffer);
  } else if (mimeType === 'image/heic' || mimeType === 'image/heif') {
    // iPhone photos. sharp's prebuilt binaries can't decode HEVC, so they
    // used to be stored as uploaded -- with their EXIF, GPS location
    // included -- and most browsers can't show HEIC anyway. Convert to JPEG,
    // which keeps the pixels and drops everything else.
    return { buffer: await heicToJpeg(buffer), mimeType: 'image/jpeg' };
  } else if (mimeType.startsWith('image/')) {
    safeBuffer = await reencodeImage(buffer, mimeType);
  }
  // Audio and video are passed through — no safe re-encoding available without ffmpeg

  return { buffer: safeBuffer, mimeType };
}

// Bytes read from the head of a file for magic-byte detection (file-type
// needs ~4100; SVG sniffing uses 4096).
const HEAD_BYTES = 64 * 1024;

/**
 * Validate an upload that multer wrote to disk.
 * Audio/video (passed through unmodified anyway) are verified from the file
 * head only and returned as { mimeType, buffer: null } so the caller can
 * stream them from disk. Images/SVG still need the full bytes for sanitizing
 * or re-encoding, so they're read and run through validateUpload().
 * Throws on rejection, like validateUpload().
 */
export async function validateUploadFile(path, claimedMimeType) {
  const fh = await open(path, 'r');
  let head;
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    head = buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }

  const sniffed = await detectMimeType(head, claimedMimeType);
  if (!sniffed || !ALLOWED_MIME_TYPES.has(sniffed)) {
    throw new Error(`File type not allowed: ${sniffed ?? claimedMimeType}`);
  }
  if (sniffed.startsWith('audio/') || sniffed.startsWith('video/')) {
    return { buffer: null, mimeType: sniffed };
  }
  return validateUpload(await readFile(path), claimedMimeType);
}
