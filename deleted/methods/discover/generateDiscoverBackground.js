// generateDiscoverBackground — build the Discover screen's background image and
// store it as the `discoverBackground` setting.
//
// Source priority: an explicit image buffer (future admin upload) > the server
// hero image (settings.profile.image) > a solid Klein-blue fallback. The chosen
// source is cover-cropped to a portrait canvas, blurred, and darkened with a
// legibility gradient (baked in so the app can drop white text straight on it).
//
// Stores a File (to:@public) and writes its URL to the discoverBackground
// setting (read directly from the DB by GET / -> getServerInfo().settings).

import sharp from "sharp";
import { File, Settings } from "#schema";
import { getStorageAdapter } from "#methods/files/index.js";
import { getSetting } from "#methods/settings/cache.js";
import { getServerSettings } from "#methods/settings/schemaHelpers.js";
import logger from "#methods/utils/logger.js";

const W = 1080;
const H = 1920; // portrait phone background
const KLEIN = { r: 0, g: 47, b: 167 }; // #002FA7
const PLACEHOLDER_RE = /\/images\//i; // static asset path, not a stored file

async function bufferFromStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// Resolve the hero image URL to bytes when it's a locally-stored file; null
// otherwise (empty, or a static /images/ asset — fall back to Klein blue).
async function heroBuffer(heroUrl, localDomain, storage) {
  try {
    if (!heroUrl || typeof heroUrl !== "string" || !heroUrl.startsWith("http")) return null;
    if (PLACEHOLDER_RE.test(heroUrl)) return null;
    const u = new URL(heroUrl);
    if (u.hostname.toLowerCase() === localDomain && u.pathname.startsWith("/files/")) {
      const fileId = decodeURIComponent(u.pathname.slice("/files/".length)).split("/")[0];
      const rec = await File.findOne({ id: fileId }).select("storageKey").lean();
      if (rec?.storageKey) {
        const buf = await bufferFromStream(await storage.getStream(rec.storageKey));
        if (buf.length) return buf;
      }
    }
  } catch {
    /* fall through to fallback */
  }
  return null;
}

// Dark legibility gradient baked over the (blurred) source: a soft top-to-bottom
// darkening plus a flat scrim, so white text and translucent panels read on any
// hero. Tuned to stay atmospheric, not muddy.
function gradientOverlay() {
  return Buffer.from(
    `<svg width="${W}" height="${H}">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#000" stop-opacity="0.14"/>
          <stop offset="0.45" stop-color="#000" stop-opacity="0.24"/>
          <stop offset="1" stop-color="#000" stop-opacity="0.46"/>
        </linearGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="#000" opacity="0.14"/>
      <rect width="${W}" height="${H}" fill="url(#g)"/>
    </svg>`
  );
}

/**
 * @param {Object} [opts]
 * @param {Buffer} [opts.sourceBuffer] Explicit source image (e.g. an admin upload).
 * @returns {Promise<{ok:boolean, url?:string, source?:string, reason?:string}>}
 */
export default async function generateDiscoverBackground(opts = {}) {
  try {
    const localDomain = (getSetting("domain") || getServerSettings()?.domain || "").toLowerCase();
    const actorId = getServerSettings()?.actorId || `@${localDomain}`;
    const storage = await getStorageAdapter();

    // Resolve the source: explicit buffer, else hero image, else Klein blue.
    let source = "provided";
    let base;
    let src = opts.sourceBuffer || null;
    if (!src) {
      const heroUrl = getSetting("profile")?.image || getServerSettings()?.profile?.image;
      src = await heroBuffer(heroUrl, localDomain, storage);
      source = src ? "hero" : "klein";
    }

    if (src) {
      base = sharp(src)
        .rotate()
        .resize(W, H, { fit: "cover", position: "attention" })
        .blur(6);
    } else {
      // Solid Klein-blue canvas (blur is moot; the gradient adds depth).
      base = sharp({ create: { width: W, height: H, channels: 4, background: { ...KLEIN, alpha: 1 } } });
    }

    const png = await base
      .ensureAlpha()
      .composite([{ input: gradientOverlay(), left: 0, top: 0 }])
      .png()
      .toBuffer();

    // Store as a File (two-save: pre-save sets id, then set the canonical URL).
    const result = await storage.upload(png, {
      originalFileName: "discover-bg.png",
      actorId,
      title: "Discover background",
      contentType: "image/png",
      generateThumbnail: false,
      isPublic: false,
    });

    const file = new File({
      actorId,
      to: "@public",
      originalFileName: "discover-bg.png",
      name: "Discover background",
      type: "Image",
      mediaType: "image/png",
      extension: "png",
      url: "pending",
      size: result.metadata.size,
      width: result.metadata.width,
      height: result.metadata.height,
      storageKey: result.key,
      processingStatus: "ready",
    });
    await file.save();
    file.url = `https://${localDomain}/files/${file.id}`;
    await file.save();

    await Settings.updateOne(
      { name: "discoverBackground" },
      {
        $set: {
          value: file.url,
          to: "@public",
          canEdit: "@admin",
          "ui.type": "image",
          "ui.label": "Discover Background",
          "ui.group": "appearance",
        },
      },
      { upsert: true }
    );

    return { ok: true, url: file.url, source };
  } catch (err) {
    logger.warn?.("[discover-bg] generate failed", { error: err?.message });
    return { ok: false, reason: "error", error: err?.message };
  }
}
