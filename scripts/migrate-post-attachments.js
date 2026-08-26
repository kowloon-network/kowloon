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
// Also backfills the matching FeedItems.object.attachments — FeedItems is a
// separate, denormalized copy of the post content (written at create/update
// time by methods/feed/writeFeedItems.js) and is what the public read paths
// (GET /posts, GET /posts/:id, ?kind= filtering) actually query, not Post
// directly. Without this, a migrated Post reads correctly via routes that
// hit Post, but the public feed/kind-filter queries keep seeing the
// pre-migration shape.
//
// Post and FeedItems are detected and healed INDEPENDENTLY: a prior partial
// or interrupted run can leave Post already migrated while FeedItems is
// still stale (or vice versa isn't possible, but is handled the same way
// for symmetry) — each collection's own current state is queried fresh, and
// an already-migrated Post is reused as the source of truth for backfilling
// a stale FeedItems copy rather than re-resolving from scratch.
//
// Idempotent: safe to re-run any number of times; only touches docs whose
// relevant field still holds the legacy string shape.
//
// Usage:
//   MONGO_URI=... node scripts/migrate-post-attachments.js [--dry-run]

import mongoose from "mongoose";
import { Post, File, FeedItems } from "../schema/index.js";
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

function resolveAttachments(rawAttachments, fileMap, stats) {
  const converted = [];
  for (const raw of rawAttachments) {
    const fid = fileIdFromValue(raw);
    if (!fid) {
      stats.droppedCount++;
      if (stats.droppedSamples.length < 10) stats.droppedSamples.push(raw);
      continue;
    }
    if (raw.startsWith("file:")) stats.localCount++;
    else stats.proxyCount++;

    const file = fileMap.get(fid);
    if (!file) stats.orphanedCount++;

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
  return converted;
}

async function main() {
  await mongoose.connect(MONGO_URI);

  const unmigratedPosts = await Post.find({ "attachments.0": { $type: "string" } })
    .select("id attachments")
    .lean();
  const staleFeedItems = await FeedItems.find({ "object.attachments.0": { $type: "string" } })
    .select("id")
    .lean();

  console.log(`Found ${unmigratedPosts.length} posts with unmigrated (string) attachments.`);
  console.log(`Found ${staleFeedItems.length} FeedItems with a stale (string) attachments copy.`);

  if (unmigratedPosts.length === 0 && staleFeedItems.length === 0) {
    await mongoose.disconnect();
    return;
  }

  // Batch-resolve every referenced fileId across the whole run, not per-doc.
  const fileIds = new Set();
  for (const doc of unmigratedPosts) {
    for (const raw of doc.attachments) {
      const fid = fileIdFromValue(raw);
      if (fid) fileIds.add(fid);
    }
  }
  const files = await File.find({ id: { $in: [...fileIds] } })
    .select("id mediaType name summary width height")
    .lean();
  const fileMap = new Map(files.map((f) => [f.id, f]));

  const stats = { localCount: 0, proxyCount: 0, orphanedCount: 0, droppedCount: 0, droppedSamples: [] };

  // postUpdates: Post-side writes needed (freshly resolved from legacy strings).
  const postUpdates = unmigratedPosts.map((doc) => ({
    id: doc.id,
    attachments: resolveAttachments(doc.attachments, fileMap, stats),
  }));

  console.log(`\nConversions by shape:`);
  console.log(`  file: ids:        ${stats.localCount}`);
  console.log(`  /files/ proxy URLs: ${stats.proxyCount}`);
  console.log(`  orphaned (no File record, degraded): ${stats.orphanedCount}`);
  console.log(`  dropped (no resolvable fileId):     ${stats.droppedCount}`);
  if (stats.droppedSamples.length) {
    console.log(`\nSample dropped values:`);
    for (const v of stats.droppedSamples) console.log(`  ${JSON.stringify(v)}`);
  }

  // feedItemUpdates: FeedItems-side writes needed — freshly-converted posts,
  // plus any stale FeedItems whose Post is already migrated (reuse it as-is,
  // no need to re-resolve).
  const feedItemUpdates = new Map(postUpdates.map((u) => [u.id, u.attachments]));
  const extraIds = staleFeedItems.map((f) => f.id).filter((id) => !feedItemUpdates.has(id));
  if (extraIds.length > 0) {
    const alreadyMigratedPosts = await Post.find({ id: { $in: extraIds } })
      .select("id attachments")
      .lean();
    for (const p of alreadyMigratedPosts) {
      feedItemUpdates.set(p.id, p.attachments);
    }
  }

  if (DRY_RUN) {
    console.log(
      `\n--dry-run: no changes written. Would update ${postUpdates.length} posts and ${feedItemUpdates.size} FeedItems.`
    );
    await mongoose.disconnect();
    return;
  }

  if (postUpdates.length > 0) {
    const ops = postUpdates.map((u) => ({
      updateOne: { filter: { id: u.id }, update: { $set: { attachments: u.attachments } } },
    }));
    const result = await Post.bulkWrite(ops, { ordered: false });
    console.log(`\nUpdated ${result.modifiedCount ?? postUpdates.length} posts.`);
  }

  if (feedItemUpdates.size > 0) {
    const feedItemOps = [...feedItemUpdates].map(([id, attachments]) => ({
      updateOne: { filter: { id }, update: { $set: { "object.attachments": attachments } } },
    }));
    const fiResult = await FeedItems.bulkWrite(feedItemOps, { ordered: false });
    console.log(
      `Updated ${fiResult.modifiedCount ?? 0} FeedItems (${feedItemOps.length - (fiResult.matchedCount ?? 0)} had no matching doc — fine, e.g. never fanned out).`
    );
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
