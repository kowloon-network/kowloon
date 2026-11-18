// methods/files/focusPoint.js
// An image's focus point: where its subject is, as fractions of its width and
// height ({ x: 0..1, y: 0..1 }, 0,0 = top left). Apps use it to keep the
// subject in frame when a feed layout has to crop a photo (#image-cropping).
//
// Two sources:
//  - the poster, who can tap the subject in the composer (sent with the
//    upload as `focus`), which always wins;
//  - otherwise sharp's "attention" strategy, which finds the region with the
//    most detail, saturation and skin tone. Cheap: it runs on a 256px copy.

const ROUND = 1000;

function clamp01(n) {
  return Math.min(1, Math.max(0, n));
}

// Accepts { x, y } or the multipart form string "x,y". Returns a clean
// { x, y } or null when the value is missing or malformed.
export function parseFocus(value) {
  let x;
  let y;
  if (typeof value === "string") {
    const parts = value.split(",");
    if (parts.length !== 2) return null;
    x = Number(parts[0]);
    y = Number(parts[1]);
  } else if (value && typeof value === "object") {
    x = Number(value.x);
    y = Number(value.y);
  } else {
    return null;
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.round(clamp01(x) * ROUND) / ROUND, y: Math.round(clamp01(y) * ROUND) / ROUND };
}

// Detect the focus point of a raster image buffer. Returns null for anything
// sharp can't read; callers treat null as "centre".
export async function detectFocus(buffer) {
  try {
    const { default: sharp } = await import("sharp");
    // Two passes. First shrink to a small copy whose short side is SIDE.
    // Running the attention crop on the original instead reports its
    // coordinates in whatever scale libvips decoded at (JPEG shrink-on-load
    // varies by size), which pinned big photos' focus to the edges.
    const SIDE = 256;
    const small = await sharp(buffer, { pages: 1 })
      .resize(SIDE, SIDE, { fit: "outside" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width: w, height: h, channels } = small.info;
    if (!w || !h) return null;
    const { info } = await sharp(small.data, { raw: { width: w, height: h, channels } })
      .resize(SIDE, SIDE, { fit: "cover", position: sharp.strategy.attention })
      .toBuffer({ resolveWithObject: true });
    if (!Number.isFinite(info.attentionX) || !Number.isFinite(info.attentionY)) return null;
    return parseFocus({ x: info.attentionX / w, y: info.attentionY / h });
  } catch (err) {
    console.warn("[files/focusPoint] detection failed:", err.message);
    return null;
  }
}
