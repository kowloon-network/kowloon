#!/usr/bin/env node
// Convert Post.attachments from legacy bare strings ([String]) to the
// persisted Attachment subdocument shape (schema/subschema/Attachment.js).
//
// Legacy strings are one of three shapes (see methods/files/fileRef.js):
//   - a local/federated Kowloon file id ("file:<id>@domain")
//   - a Kowloon file-proxy URL ("https://domain/files/<encoded file id>")
//   - a bare external URL with no resolvable file id
//
// The new schema requires `fileId`, so a bare external URL with no
// resolvable file id has nothing to migrate to — it's dropped (logged, not
// silently lost). Kowloon-only federation means this should be rare/legacy.
//
// Idempotent: only matches docs whose first attachment element is still a
// string, so already-migrated docs are skipped on a re-run.
//
// Usage:
//   MONGO_URI=... node scripts/migrate-post-attachments.js [--dry-run]

import mongoose from "mongoose";
import { Post, File } from "../schema/index.js";
import { fileIdFromValue } from "../methods/files/fileRef.js";
import { mapKind } from "../methods/files/resolveAttachment.js";

const DRY_RUN = process.argv.includes("--dry-run");
const MONGO_URI =
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  process.env.MONGO_URL ||
  process.env.DATABASE_URL;

if (!MONGO_URI) {
  console.error("Missing MONGO_URI env var.");
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGO_URI);

  const docs = await Post.find({ "attachments.0": { $type: "string" } })
    .select("id attachments")
    .lean();

  console.log(`Found ${docs.length} posts with unmigrated (string) attachments.`);

  if (docs.length === 0) {
    await mongoose.disconnect();
    return;
  }

  // Batch-resolve every referenced fileId across the whole run, not per-doc.
  const fileIds = new Set();
  for (const doc of docs) {
    for (const raw of doc.attachments) {
      const fid = fileIdFromValue(raw);
      if (fid) fileIds.add(fid);
    }
  }
  const files = await File.find({ id: { $in: [...fileIds] } })
    .select("id mediaType name summary width height")
    .lean();
  const fileMap = new Map(files.map((f) => [f.id, f]));

  let localCount = 0;
  let proxyCount = 0;
  let orphanedCount = 0; // fileId resolvable but no matching File record
  let droppedCount = 0; // no resolvable fileId at all
  const droppedSamples = [];
  const updates = [];

  for (const doc of docs) {
    const converted = [];
    for (const raw of doc.attachments) {
      const fid = fileIdFromValue(raw);
      if (!fid) {
        droppedCount++;
        if (droppedSamples.length < 10) droppedSamples.push({ postId: doc.id, value: raw });
        continue;
      }
      if (raw.startsWith("file:")) localCount++;
      else proxyCount++;

      const file = fileMap.get(fid);
      if (!file) orphanedCount++;

      const mediaType = file?.mediaType ?? "";
      converted.push({
        fileId: fid,
        mediaType,
        kind: mapKind(mediaType),
        name: file?.name ?? "",
        alt: file?.summary ?? "",
        width: file?.width ?? null,
        height: file?.height ?? null,
      });
    }
    updates.push({ id: doc.id, attachments: converted });
  }

  console.log(`\nConversions by shape:`);
  console.log(`  file: ids:        ${localCount}`);
  console.log(`  /files/ proxy URLs: ${proxyCount}`);
  console.log(`  orphaned (no File record, degraded): ${orphanedCount}`);
  console.log(`  dropped (no resolvable fileId):     ${droppedCount}`);
  if (droppedSamples.length) {
    console.log(`\nSample dropped values:`);
    for (const s of droppedSamples) console.log(`  ${s.postId}: ${JSON.stringify(s.value)}`);
  }

  if (DRY_RUN) {
    console.log(`\n--dry-run: no changes written. Would update ${updates.length} posts.`);
    await mongoose.disconnect();
    return;
  }

  const ops = updates.map((u) => ({
    updateOne: {
      filter: { id: u.id },
      update: { $set: { attachments: u.attachments } },
    },
  }));
  const result = await Post.bulkWrite(ops, { ordered: false });
  console.log(`\nUpdated ${result.modifiedCount ?? updates.length} posts.`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
