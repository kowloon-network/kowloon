// methods/files/proxyBodyImages.js
//
// PRIVACY: Post/Reply bodies allow <img src> to any http(s) host. Rendering
// such a body makes every reader's browser fetch from that host, leaking
// their IP (and timing/User-Agent) to whoever controls it -- a tracking pixel
// in a post. There is no live public image-proxy route, so we use the same
// mechanism as link-preview og:images (methods/files/proxyExternalImage.js):
// download the image server-side into local storage once, and point the
// rendered body at our own /files/<id> URL.
//
// Called from the Post/Reply schema hooks after safeMarkdown() renders the
// body. Anything that can't be proxied (download failed, not an image, over
// the per-document cap) is turned into a plain link instead, so the reader's
// browser never auto-loads a third-party URL.
//
// Visibility: the stored File's parentObject is the object whose `to`
// governs access (a Post itself; for a Reply, its root target -- Reply.to is
// always "" by design, which file serving would treat as public).

import sanitizeHtml from "#methods/utils/sanitize.js";
import File from "#schema/File.js";
import { storeExternalImage } from "./proxyExternalImage.js";

const MAX_IMAGES_PER_DOC = 10;

const IMG_SRC_RE = /<img\b[^>]*?\bsrc="([^"]*)"/gi;

function decodeAttr(v) {
  return String(v)
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function isExternalImageUrl(src, domain) {
  if (typeof src !== "string" || !/^https?:\/\//i.test(src)) return false; // relative (/files/...) is ours
  let host;
  try {
    host = new URL(src).hostname.toLowerCase();
  } catch {
    return false;
  }
  return !domain || host !== String(domain).toLowerCase();
}

/**
 * @param {string} html - sanitized HTML from safeMarkdown()
 * @param {{ domain: string, actorId: string, parentObject: string }} ctx
 * @returns {Promise<string>} html with external <img> rewritten
 */
export default async function proxyBodyImages(html, { domain, actorId, parentObject }) {
  if (!html || !/<img\b/i.test(html)) return html;

  const external = [];
  for (const m of html.matchAll(IMG_SRC_RE)) {
    const src = decodeAttr(m[1]);
    if (isExternalImageUrl(src, domain) && !external.includes(src)) external.push(src);
  }
  if (!external.length) return html;

  const map = new Map(); // external src -> local file URL
  const toResolve = external.slice(0, MAX_IMAGES_PER_DOC);

  // Reuse copies already stored for this parent (every re-save re-renders).
  if (parentObject) {
    const existing = await File.find({
      parentObject,
      sourceUrl: { $in: toResolve },
      deletedAt: null,
    })
      .select("sourceUrl url")
      .lean();
    for (const f of existing) if (f.url && f.url !== "pending") map.set(f.sourceUrl, f.url);
  }

  if (actorId && parentObject) {
    await Promise.all(
      toResolve
        .filter((src) => !map.has(src))
        .map(async (src) => {
          const file = await storeExternalImage({ url: src, actorId, parentObject });
          if (file?.url) map.set(src, file.url);
        })
    );
  }

  // Second pass over already-sanitized HTML: only rewrites img tags, so
  // allowing everything through here can't reintroduce anything.
  return sanitizeHtml(html, {
    allowedTags: false,
    allowedAttributes: false,
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      img: (tagName, attribs) => {
        const src = attribs.src;
        if (!isExternalImageUrl(src, domain)) return { tagName, attribs };
        const local = map.get(src);
        if (local) return { tagName, attribs: { ...attribs, src: local } };
        // Couldn't proxy: degrade to a link the reader can choose to follow.
        return {
          tagName: "a",
          attribs: { href: src, rel: "nofollow noopener noreferrer", target: "_blank" },
          text: attribs.alt || attribs.title || src,
        };
      },
    },
  });
}
