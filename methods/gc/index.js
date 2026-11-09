// methods/gc/index.js
// Nightly garbage collection: hard-delete aged soft-deleted objects, orphaned remote FeedItems,
// and files attached to permanently deleted objects.

import mongoose from "mongoose";
import os from "os";
import { randomUUID } from "crypto";
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

  // Pass 2: Purge orphaned remote FeedItems (remote posts with no FeedFanOut records).
  // Batched: one distinct() per 1000 items instead of one exists() per item.
  const ORPHAN_BATCH = 1000;
  const remoteCursor = FeedItems.find({ origin: "remote" }).select("id _id").lean().cursor();
  let batch = [];
  const flushOrphans = async () => {
    if (!batch.length) return;
    const ids = batch.map((b) => b.id).filter(Boolean);
    const withFanOut = new Set(
      ids.length ? await FeedFanOut.distinct("feedItemId", { feedItemId: { $in: ids } }) : []
    );
    const orphaned = batch.filter((b) => !withFanOut.has(b.id)).map((b) => b._id);
    if (orphaned.length) {
      await FeedItems.deleteMany({ _id: { $in: orphaned } });
      totalOrphanedFeedItems += orphaned.length;
    }
    batch = [];
  };
  for await (const item of remoteCursor) {
    batch.push(item);
    if (batch.length >= ORPHAN_BATCH) await flushOrphans();
  }
  await flushOrphans();
  if (totalOrphanedFeedItems > 0) {
    console.log(`[gc] Purged ${totalOrphanedFeedItems} orphaned remote FeedItems`);
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
  //
  // Local-domain ids are excluded in the query itself (the JS check below
  // stays as a belt-and-braces guard) so we don't load every old local upload.
  const localDomain = (process.env.DOMAIN || getSetting("domain") || "").toLowerCase();
  const localIdRe = localDomain
    ? new RegExp(`@${localDomain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i")
    : null;
  const remoteCacheCandidates = await File.find({
    deletedAt: null,
    storageKey: { $exists: true, $ne: null },
    ...(localIdRe ? { id: { $not: localIdRe } } : {}),
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
const GC_LOCK_TTL_MS = 2 * 60 * 60 * 1000;  // a crashed holder's lock expires after 2h
const GC_MIN_GAP_MS  = 20 * 60 * 60 * 1000; // skip if any instance ran within 20h
const GC_MAX_JITTER_MS = 30 * 60 * 1000;    // 0-30 min random start delay

// Advisory lock in a dedicated `locks` collection (per database, i.e. per
// site). Every app instance schedules GC; this makes sure only one runs it at
// a time, and that restarts/deploys don't re-run it within GC_MIN_GAP_MS.
// The upsert races resolve via the unique _id: a loser gets E11000 = held.
const GC_LOCK_ID = "gc";
const lockOwner = `${os.hostname()}:${process.pid}:${randomUUID()}`;

function locks() {
  return mongoose.connection.collection("locks");
}

async function acquireGcLock() {
  const now = new Date();
  try {
    const res = await locks().findOneAndUpdate(
      {
        _id: GC_LOCK_ID,
        $and: [
          { $or: [{ expiresAt: { $lt: now } }, { expiresAt: null }] },
          { $or: [{ lastRunAt: { $lt: new Date(now.getTime() - GC_MIN_GAP_MS) } }, { lastRunAt: null }] },
        ],
      },
      { $set: { owner: lockOwner, acquiredAt: now, expiresAt: new Date(now.getTime() + GC_LOCK_TTL_MS) } },
      { upsert: true, returnDocument: "after" }
    );
    const doc = res?.value !== undefined ? res.value : res; // driver v5 vs v6 shape
    return doc?.owner === lockOwner;
  } catch (err) {
    if (err?.code === 11000) return false; // held by someone else / ran recently
    throw err;
  }
}

async function releaseGcLock({ ran }) {
  await locks().updateOne(
    { _id: GC_LOCK_ID, owner: lockOwner },
    { $set: { expiresAt: null, ...(ran ? { lastRunAt: new Date() } : {}) } }
  ).catch((err) => console.error("[gc] lock release failed:", err.message));
}

export async function runGCWithLock() {
  if (!(await acquireGcLock())) {
    console.log("[gc] Skipping: another instance holds the GC lock or ran recently");
    return;
  }
  let ran = false;
  try {
    await runGC();
    ran = true;
  } finally {
    await releaseGcLock({ ran });
  }
}

export function startGCWorker() {
  // First run 1 min + random 0-30 min after startup (so instances on the same
  // box don't all fire together after a deploy), then every 24 hours. The
  // lock above makes only one instance per database actually run it.
  const jitter = Math.floor(Math.random() * GC_MAX_JITTER_MS);
  const tick = () =>
    runGCWithLock().catch((err) => console.error("[gc] GC run failed:", err.message));
  setTimeout(() => {
    tick();
    setInterval(tick, GC_INTERVAL_MS);
  }, 60_000 + jitter);

  console.log(`[gc] GC worker scheduled (runs every 24h, first run in ${Math.round((60_000 + jitter) / 60_000)} min)`);
}

export default { startGCWorker, runGC, runGCWithLock };
