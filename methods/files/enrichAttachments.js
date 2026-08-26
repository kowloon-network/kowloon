// Resolve post `image` + `attachments` references to client-usable shapes.
//
// `attachments` is now a persisted, fully-resolved Attachment subdocument
// (fileId/mediaType/kind/name/alt/width/height — see schema/subschema/Attachment.js),
// snapshotted at write time. Reading it back is a pure transform: build the
// serving URL from fileId, no File lookup needed. `image` is a separate,
// untouched field (still a bare File-ID/URL string) and still needs one.
//
// Transition tolerance: a bare-string attachment (an unmigrated doc, or a
// federation peer on an older deploy) falls back to the old on-the-fly File
// lookup so it still renders correctly. Drop this fallback once all 3
// servers are confirmed migrated (scripts/migrate-post-attachments.js).
//
// Restricted (non-public) files get a short-lived signed URL. Mutates
// `items` in place.

import { File } from "#schema";
import { buildFileUrl, isPublicVisibility } from "#methods/files/signedUrl.js";
import { fileIdFromValue } from "#methods/files/fileRef.js";
import { getSetting } from "#methods/settings/cache.js";

export async function enrichAttachments(items, { protocol = "https" } = {}) {
  if (!Array.isArray(items) || items.length === 0) return items;
  const domain = getSetting("domain");

  // Gather image fileIds and any legacy (bare-string) attachment fileIds —
  // the only two cases that still need a File lookup.
  const legacyFileIds = new Set();
  const restrictedLegacyIds = new Set();
  for (const item of items) {
    const restricted = !isPublicVisibility(item?.to);
    const add = (v) => {
      const fid = fileIdFromValue(v);
      if (!fid) return;
      legacyFileIds.add(fid);
      if (restricted) restrictedLegacyIds.add(fid);
    };
    add(item?.image);
    for (const a of item?.attachments ?? []) {
      if (typeof a === "string") add(a);
    }
  }

  const legacyMap = new Map();
  if (legacyFileIds.size > 0) {
    const files = await File.find({ id: { $in: [...legacyFileIds] } })
      .select("id mediaType name summary width height")
      .lean();
    for (const f of files) {
      legacyMap.set(f.id, {
        fileId: f.id,
        mediaType: f.mediaType ?? "",
        kind: mapKind(f.mediaType),
        name: f.name ?? "",
        alt: f.summary ?? "",
        width: f.width ?? null,
        height: f.height ?? null,
        restricted: restrictedLegacyIds.has(f.id),
      });
    }
  }

  for (const item of items) {
    const restricted = !isPublicVisibility(item?.to);

    const imgFid = fileIdFromValue(item?.image);
    if (imgFid) {
      item.featuredImage = buildFileUrl({ fileId: imgFid, domain, protocol, restricted });
    } else if (typeof item?.image === "string" && item.image.startsWith("http")) {
      item.featuredImage = item.image;
    }

    if (item?.attachments?.length) {
      item.attachments = item.attachments
        .map((a) => resolveOne(a, { domain, protocol, restricted, legacyMap }))
        .filter(Boolean);
    }
  }

  return items;
}

function mapKind(mediaType) {
  const mt = String(mediaType || "");
  if (mt.startsWith("image/")) return "photo";
  if (mt.startsWith("video/")) return "video";
  if (mt.startsWith("audio/")) return "audio";
  return "file";
}

function resolveOne(a, { domain, protocol, restricted, legacyMap }) {
  // Current shape: a fully-resolved Attachment subdocument — pure transform.
  if (a && typeof a === "object" && a.fileId) {
    return {
      url: buildFileUrl({ fileId: a.fileId, domain, protocol, restricted }),
      fileId: a.fileId,
      mediaType: a.mediaType ?? "",
      kind: a.kind ?? "file",
      name: a.name ?? "",
      alt: a.alt ?? "",
      width: a.width ?? null,
      height: a.height ?? null,
    };
  }

  // Legacy bare string — resolve via the batched File lookup above.
  if (typeof a === "string") {
    const fid = fileIdFromValue(a);
    if (fid) {
      const entry = legacyMap.get(fid);
      if (entry) {
        return {
          url: buildFileUrl({ fileId: fid, domain, protocol, restricted }),
          fileId: fid,
          mediaType: entry.mediaType,
          kind: entry.kind,
          name: entry.name,
          alt: entry.alt,
          width: entry.width,
          height: entry.height,
        };
      }
      return { url: buildFileUrl({ fileId: fid, domain, protocol, restricted }), fileId: fid, mediaType: "", kind: "file", name: "", alt: "", width: null, height: null };
    }
    if (a.startsWith("http")) return { url: a, mediaType: "", kind: "file", name: "", alt: "" };
  }

  return null;
}
