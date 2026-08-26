// methods/files/resolveAttachment.js
// Resolves raw attachment references — legacy bare strings, the client's
// {fileId, title, alt} create/update shape, or already-resolved objects sent
// back by edit screens — into persisted Attachment subdocuments (see
// schema/subschema/Attachment.js). One batched File lookup for the whole
// array, not N queries.

import { File } from "#schema";
import { fileIdFromValue } from "./fileRef.js";

export function mapKind(mediaType) {
  const mt = String(mediaType || "");
  if (mt.startsWith("image/")) return "photo";
  if (mt.startsWith("video/")) return "video";
  if (mt.startsWith("audio/")) return "audio";
  return "file";
}

// Normalize one raw entry to { fileId, title?, alt? }, or null if no fileId
// can be resolved — dropped, since Kowloon-only federation means every
// legitimate attachment always has one.
function normalizeEntry(raw) {
  if (typeof raw === "string") {
    const fileId = fileIdFromValue(raw);
    return fileId ? { fileId } : null;
  }
  if (raw && typeof raw === "object") {
    const fileId = raw.fileId || fileIdFromValue(raw.url) || fileIdFromValue(raw.id);
    if (!fileId) return null;
    return { fileId, title: raw.title, alt: raw.alt ?? raw.summary };
  }
  return null;
}

export async function resolveAttachments(rawAttachments) {
  if (!Array.isArray(rawAttachments) || rawAttachments.length === 0) return [];

  const entries = rawAttachments.map(normalizeEntry).filter(Boolean);
  if (entries.length === 0) return [];

  const fileIds = [...new Set(entries.map((e) => e.fileId))];
  const files = await File.find({ id: { $in: fileIds } })
    .select("id mediaType name summary width height")
    .lean();
  const fileMap = new Map(files.map((f) => [f.id, f]));

  // Unresolved fileId (not yet hydrated for a remote peer, or a race with an
  // in-flight upload) degrades to empty metadata rather than being dropped —
  // it may resolve on a later read once the File record catches up.
  return entries.map((entry) => {
    const file = fileMap.get(entry.fileId);
    const mediaType = file?.mediaType ?? "";
    return {
      fileId: entry.fileId,
      mediaType,
      kind: mapKind(mediaType),
      name: entry.title ?? file?.name ?? "",
      alt: entry.alt ?? file?.summary ?? "",
      width: file?.width ?? null,
      height: file?.height ?? null,
    };
  });
}

export default resolveAttachments;
