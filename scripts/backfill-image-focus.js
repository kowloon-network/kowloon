#!/usr/bin/env node
// Backfill focus points (and any missing width/height) for image File
// records uploaded before focus detection existed, then copy them onto the
// attachment snapshots that reference each file -- Post, Page and the
// denormalized FeedItems copy -- so feeds can crop around the subject.
// See methods/files/focusPoint.js.
//
// Idempotent: only touches images whose focus is still unset.
//
// Usage:
//   node scripts/backfill-image-focus.js              # dry run (counts only)
//   node scripts/backfill-image-focus.js --write      # apply
//   node scripts/backfill-image-focus.js --write --limit 50

import "dotenv/config";
import mongoose from "mongoose";
import { getStorageAdapter } from "../methods/files/index.js";
import { detectFocus } from "../methods/files/focusPoint.js";

const RawFile = mongoose.model("RawFile", new mongoose.Schema({}, { strict: false, collection: "files" }));
const RawPost = mongoose.model("RawPost", new mongoose.Schema({}, { strict: false, collection: "posts" }));
const RawPage = mongoose.model("RawPage", new mongoose.Schema({}, { strict: false, collection: "pages" }));
const RawFeed = mongoose.model("RawFeed", new mongoose.Schema({}, { strict: false, collection: "feeditems" }));

const args = process.argv.slice(2);
const DRY_RUN = !args.includes("--write");
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 0;

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Set fields on every attachment subdocument pointing at fileId.
async function patchAttachments(fileId, fields) {
  const arrayFilters = [{ "elem.fileId": fileId }];
  const set = (prefix) =>
    Object.fromEntries(Object.entries(fields).map(([k, v]) => [`${prefix}.$[elem].${k}`, v]));
  const results = await Promise.all([
    RawPost.updateMany({ "attachments.fileId": fileId }, { $set: set("attachments") }, { arrayFilters }),
    RawPage.updateMany({ "attachments.fileId": fileId }, { $set: set("attachments") }, { arrayFilters }),
    RawFeed.updateMany(
      { "object.attachments.fileId": fileId },
      { $set: set("object.attachments") },
      { arrayFilters }
    ),
  ]);
  return results.reduce((n, r) => n + (r.modifiedCount || 0), 0);
}

async function main() {
  const mongoUrl = process.env.MONGO_URI || process.env.MONGO_URL || "mongodb://localhost:27017/kowloon";
  await mongoose.connect(mongoUrl);
  console.log(DRY_RUN ? "DRY RUN -- pass --write to apply changes" : "WRITE MODE");

  const storage = await getStorageAdapter();
  const query = {
    mediaType: { $regex: /^image\//, $ne: "image/svg+xml" },
    storageKey: { $exists: true, $ne: null },
    $or: [{ focus: null }, { focus: { $exists: false } }],
    deletedAt: null,
  };
  const cursor = RawFile.find(query).limit(LIMIT > 0 ? LIMIT : 0).lean().cursor();

  let processed = 0;
  let snapshots = 0;
  let errored = 0;
  for await (const file of cursor) {
    try {
      if (DRY_RUN) {
        console.log(`  ${file.id}  [${file.mediaType}]`);
        processed++;
        continue;
      }
      const buffer = await streamToBuffer(await storage.getStream(file.storageKey));
      const focus = (await detectFocus(buffer)) || { x: 0.5, y: 0.5 };
      const fields = { focus };
      if (!file.width || !file.height) {
        const { default: sharp } = await import("sharp");
        const meta = await sharp(buffer, { pages: 1 }).metadata();
        if (meta.width && meta.height) {
          fields.width = meta.width;
          fields.height = meta.pageHeight || meta.height;
        }
      }
      await RawFile.updateOne({ _id: file._id }, { $set: fields });
      snapshots += await patchAttachments(file.id, fields);
      processed++;
      if (processed % 25 === 0) console.log(`  Processed ${processed}...`);
    } catch (err) {
      errored++;
      console.error(`  Error on ${file.id}: ${err.message}`);
    }
  }

  console.log("");
  console.log(`Images ${DRY_RUN ? "to process" : "processed"}: ${processed}`);
  if (!DRY_RUN) console.log(`Attachment snapshots updated: ${snapshots}`);
  console.log(`Errors: ${errored}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
