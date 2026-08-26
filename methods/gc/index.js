// methods/gc/index.js
// Nightly garbage collection: hard-delete aged soft-deleted objects, orphaned remote FeedItems,
// and files attached to permanently deleted objects.

import {
  Post, Reply, Page, Group, User, Bookmark,
  FeedItems, FeedFanOut, File,
} from "#schema";
import { getSetting } from "#methods/settings/cache.js";
import { getStorageAdapter } from "#methods/files/index.js";
import kowloonId from "#methods/parse/kowloonId.js";
import isLocalDomain from "#methods/parse/isLocalDomain.js";

const SOFT_DELETE_MODELS = [Post, Reply, Page, Group, User, Bookmark];

async function deleteFileFromStorage(file) {
  if (!file.storageKey) return;
  try {
    const storage = await getStorageAdapter();
    await storage.delete(file.storageKey);
    if (file.thumbnails && typeof file.thumbnails === "object") {
      for (const key of Object.values(file.thumbnails)) {
        await storage.delete(key).catch(() => {});
      }
    }
  } catch (err) {
    console.error(`[gc] Storage delete failed for ${file.id}:`, err.message);
  }
}

async function purgeFilesForObject(objectId) {
  const files = await File.find({ parentObject: objectId, deletedAt: null }).lean();
  for (const file of files) {
    await deleteFileFromStorage(file);
    await File.deleteOne({ _id: file._id });
  }
  if (files.length > 0) {
    console.log(`[gc] Purged ${files.length} file(s) for ${objectId}`);
  }
}

async function runGC() {
  const retentionDays = Number(getSetting("gcRetentionDays") ?? 30);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  let totalHardDeleted = 0;
  let totalFilesDeleted = 0;
  let totalOrphanedFeedItems = 0;

  console.log(`[gc] Starting GC run — retention: ${retentionDays} days, cutoff: ${cutoff.toISOString()}`);

  // Pass 1: Hard-delete aged soft-deleted content objects, purge their files
  for (const Model of SOFT_DELETE_MODELS) {
    const expired = await Model.find({
      deletedAt: { $ne: null, $lt: cutoff },
    }).select("id _id").lean();

    for (const doc of expired) {
      await purgeFilesForObject(doc.id);
      await FeedFanOut.deleteMany({ feedItemId: doc.id });
      await Model.deleteOne({ _id: doc._id });
      totalHardDeleted++;
    }

    if (expired.length > 0) {
      console.log(`[gc] Hard-deleted ${expired.length} expired ${Model.modelName} docs`);
    }
  }

  // Pass 2: Purge orphaned remote FeedItems (remote posts with no FeedFanOut records)
  const remoteFeedItems = await FeedItems.find({ origin: "remote" }).select("id _id").lean();
  const orphaned = [];
  for (const item of remoteFeedItems) {
    const hasFanOut = await FeedFanOut.exists({ feedItemId: item.id });
    if (!hasFanOut) orphaned.push(item._id);
  }
  if (orphaned.length > 0) {
    await FeedItems.deleteMany({ _id: { $in: orphaned } });
    totalOrphanedFeedItems = orphaned.length;
    console.log(`[gc] Purged ${orphaned.length} orphaned remote FeedItems`);
  }

  // Pass 3: Purge soft-deleted File records whose storage was already cleaned
  const deletedFiles = await File.find({
    deletedAt: { $ne: null, $lt: cutoff },
  }).lean();
  for (const file of deletedFiles) {
    await deleteFileFromStorage(file);
    await File.deleteOne({ _id: file._id });
    totalFilesDeleted++;
  }
  if (deletedFiles.length > 0) {
    console.log(`[gc] Hard-deleted ${deletedFiles.length} expired File records`);
  }

  // Pass 4: Expire stale remote-cache File shadows — our own re-fetchable
  // mirror of another server's public media (see hydrateRemoteFile.js), not
  // gated on deletedAt since these were never "deleted", just cached. Scoped
  // to non-local origin (derived from the id itself, the same way the rest
  // of the app determines it) so this can never match a real local upload,
  // whose id always carries the local domain. Real uploads persist forever
  // unless explicitly deleted — this only expires content that lives
  // permanently on some OTHER Kowloon server and can always be re-fetched.
  //
  // LRU via lastViewed (bumped by routes/files/serve.js on each successful
  // serve, issue #55) rather than a flat time-since-cached TTL — an actively
  // viewed cached file survives; an ignored one doesn't, regardless of when
  // it was first hydrated. Falls back to updatedAt for shadows that predate
  // this field (lastViewed still null — never served since the upgrade, or
  // hydrated-but-never-viewed) so those aren't pinned forever.
  const remoteCacheCandidates = await File.find({
    deletedAt: null,
    storageKey: { $exists: true, $ne: null },
    $or: [
      { lastViewed: { $lt: cutoff } },
      { lastViewed: null, updatedAt: { $lt: cutoff } },
    ],
  }).lean();
  let totalRemoteCacheExpired = 0;
  for (const file of remoteCacheCandidates) {
    const parsed = kowloonId(file.id);
    if (!parsed?.domain || isLocalDomain(parsed.domain)) continue; // real local upload — never touch
    await deleteFileFromStorage(file);
    await File.deleteOne({ _id: file._id });
    totalRemoteCacheExpired++;
  }
  if (totalRemoteCacheExpired > 0) {
    console.log(`[gc] Expired ${totalRemoteCacheExpired} stale remote-cache file(s)`);
  }

  console.log(
    `[gc] Done — ${totalHardDeleted} objects, ${totalFilesDeleted} files, ${totalOrphanedFeedItems} orphaned feed items, ${totalRemoteCacheExpired} remote-cache files expired`
  );
}

const GC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function startGCWorker() {
  // Run once shortly after startup, then every 24 hours
  setTimeout(() => {
    runGC().catch((err) => console.error("[gc] GC run failed:", err.message));
    setInterval(() => {
      runGC().catch((err) => console.error("[gc] GC run failed:", err.message));
    }, GC_INTERVAL_MS);
  }, 60_000); // 1-minute startup delay so server is fully ready

  console.log("[gc] GC worker scheduled (runs every 24h, first run in 1 min)");
}

export default { startGCWorker, runGC };
