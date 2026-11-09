// regenerateCircleIcon — rebuild a user Circle's auto mosaic icon from the
// avatars of its first six members and store it as the circle's icon.
//
// Called fire-and-forget from the Add/Remove membership handlers. Safe to call
// often: it self-guards on eligibility and never throws to the caller.
//
// Rules:
//  - Only local, type:"Circle" circles (not System circles, not remote shadows).
//  - Only when the current icon is auto-generated, unset, or the placeholder —
//    a creator-supplied icon is never overwritten (iconGenerated tracks this).
//  - First six members, in order; the empty 6th slot renders black at 5 members.
//  - Mild avatar staleness is accepted: we regenerate on membership change, not
//    when a member later swaps their own avatar.

import { Circle, File } from "#schema";
import { getStorageAdapter } from "#methods/files/index.js";
import { getSetting } from "#methods/settings/cache.js";
import { isSafeUrl, safeFetch } from "#methods/utils/safeUrl.js";
import logger from "#methods/utils/logger.js";
import generateCircleIcon from "./generateCircleIcon.js";

const FETCH_TIMEOUT_MS = 8000;
const MAX_AVATAR_BYTES = 10 * 1024 * 1024;
const PLACEHOLDER_RE = /\/images\/(circle|user|group)\.svg(\?.*)?$/i;

async function bufferFromStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// Resolve a member's avatar URL to image bytes. Local /files/ URLs read straight
// from storage (no auth proxy round-trip); everything else is an SSRF-guarded,
// size-capped fetch. Returns null on anything unusable (caller draws a neutral
// panel for that slot).
async function fetchAvatarBuffer(iconUrl, localDomain, storage) {
  try {
    if (!iconUrl || typeof iconUrl !== "string" || !iconUrl.startsWith("http")) return null;
    if (PLACEHOLDER_RE.test(iconUrl)) return null; // static placeholder = no avatar

    let u;
    try { u = new URL(iconUrl); } catch { return null; }

    // Local, app-proxied file → pull bytes directly from storage.
    if (u.hostname.toLowerCase() === localDomain && u.pathname.startsWith("/files/")) {
      const fileId = decodeURIComponent(u.pathname.slice("/files/".length)).split("/")[0];
      if (fileId) {
        const rec = await File.findOne({ id: fileId }).select("storageKey").lean();
        if (rec?.storageKey) {
          const stream = await storage.getStream(rec.storageKey);
          const buf = await bufferFromStream(stream);
          if (buf.length && buf.length <= MAX_AVATAR_BYTES) return buf;
        }
      }
      // fall through to a plain fetch if the record/key is missing
    }

    if (!(await isSafeUrl(iconUrl))) return null;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      // SECURITY: safeFetch re-checks every redirect hop against the SSRF guard.
      const res = await safeFetch(iconUrl, {
        signal: ctrl.signal,
        headers: { "User-Agent": "kowloon/1.0 (+circle-icon)" },
      });
      if (!res.ok) return null;
      const ct = res.headers.get("content-type") || "";
      if (ct && !ct.startsWith("image/")) return null;
      const len = parseInt(res.headers.get("content-length") || "0", 10);
      if (len > MAX_AVATAR_BYTES) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > MAX_AVATAR_BYTES) return null;
      return buf;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

// Best-effort cleanup of the previous auto-generated icon file (avoid orphans).
async function deleteOldIconFile(oldIconUrl, keepId, storage) {
  try {
    if (!oldIconUrl || !oldIconUrl.includes("/files/")) return;
    const id = decodeURIComponent(new URL(oldIconUrl).pathname.slice("/files/".length)).split("/")[0];
    if (!id || id === keepId) return;
    const rec = await File.findOne({ id }).select("storageKey").lean();
    if (rec?.storageKey && typeof storage.delete === "function") {
      await storage.delete(rec.storageKey).catch(() => {});
    }
    await File.deleteOne({ id });
  } catch {
    /* non-fatal */
  }
}

export default async function regenerateCircleIcon(circleId) {
  try {
    if (!circleId) return { ok: false, reason: "no-id" };

    const circle = await Circle.findOne({ id: circleId })
      .select("id name actorId type icon iconGenerated members")
      .lean();
    if (!circle) return { ok: false, reason: "not-found" };

    // Scope: local, user-created circles only.
    if (circle.type !== "Circle") return { ok: false, reason: "not-user-circle" };
    const localDomain = (getSetting("domain") || "").toLowerCase();
    if (!localDomain || !circle.id.endsWith(`@${localDomain}`)) return { ok: false, reason: "not-local" };

    const members = (circle.members || []).slice(0, 6);

    // Eligibility: never clobber a creator-supplied icon. Auto-eligible when the
    // icon is unset/placeholder, already generated by us, OR just a copy of a
    // member's avatar — the legacy "first member's avatar" default the clients
    // still send at create time (compared with URL-encoding normalized).
    const norm = (u) => { try { return decodeURIComponent(u || "").toLowerCase(); } catch { return (u || "").toLowerCase(); } };
    const memberIcons = new Set((circle.members || []).map((m) => norm(m.icon)).filter(Boolean));
    const isPlaceholder = !circle.icon || PLACEHOLDER_RE.test(circle.icon);
    const isMemberAvatar = circle.icon && memberIcons.has(norm(circle.icon));
    const eligible = circle.iconGenerated === true || isPlaceholder || isMemberAvatar;
    if (!eligible) return { ok: false, reason: "custom-icon" };

    if (members.length === 0) return { ok: false, reason: "no-members" };

    const storage = await getStorageAdapter();
    const avatars = await Promise.all(
      members.map((m) => fetchAvatarBuffer(m.icon, localDomain, storage))
    );
    if (!avatars.some(Boolean)) return { ok: false, reason: "no-avatars" };

    const png = await generateCircleIcon(avatars);

    // Store bytes + thumbnails, then create the File (two-save: pre-save sets id).
    const result = await storage.upload(png, {
      originalFileName: "circle-icon.png",
      actorId: circle.actorId,
      title: `${circle.name || "Circle"} icon`,
      contentType: "image/png",
      generateThumbnail: true,
      thumbnailSizes: [200, 400],
      isPublic: false,
    });

    let thumbnails = null;
    if (result.thumbnails) {
      thumbnails = {};
      for (const [size] of Object.entries(result.thumbnails)) {
        thumbnails[size] = `thumbnails/${result.key.replace(/\.[^.]+$/, "")}_${size}.webp`;
      }
    }

    const file = new File({
      actorId: circle.actorId,
      to: "@public",
      // Deliberately NO parentObject: a circle icon is public branding (a
      // composite of already-public member avatars, reachable only via the
      // circle object itself). Inheriting the circle's `to` breaks the icon for
      // self-addressed/private circles like Following — the file serves 401 and
      // the client's plain <img> URL can't load it. Keep the icon standalone
      // @public regardless of the circle's audience.
      originalFileName: "circle-icon.png",
      name: `${circle.name || "Circle"} icon`,
      type: "Image",
      mediaType: "image/png",
      extension: "png",
      url: "pending",
      size: result.metadata.size,
      width: result.metadata.width,
      height: result.metadata.height,
      storageKey: result.key,
      thumbnails,
      processingStatus: "ready",
    });
    await file.save();
    file.url = `https://${localDomain}/files/${file.id}`;
    await file.save();

    await Circle.updateOne(
      { id: circle.id },
      { $set: { icon: file.url, iconGenerated: true } }
    );

    // Retire the previous generated icon (only if the old one was ours).
    if (circle.iconGenerated === true) {
      await deleteOldIconFile(circle.icon, file.id, storage);
    }

    return { ok: true, icon: file.url, members: members.length };
  } catch (err) {
    logger.warn?.("[circle-icon] regenerate failed", { circleId, error: err?.message });
    return { ok: false, reason: "error", error: err?.message };
  }
}
