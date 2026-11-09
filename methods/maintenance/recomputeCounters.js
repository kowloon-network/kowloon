// methods/maintenance/recomputeCounters.js
//
// Nightly self-heal for denormalized counters. The ActivityParser handlers
// keep these up to date with guarded $inc's, but any crash between steps,
// race, or legacy bug leaves them drifted forever unless something recomputes
// them from the source of truth. This does exactly that:
//
//   Post.replyCount   = live (non-deleted) Replies whose target is the post
//   Reply.replyCount  = live second-level Replies whose parent is the reply
//   FeedItems.object.replyCount mirrors Post.replyCount
//   Circle.memberCount = members.length
//   Group.memberCount  = length of the group's members circle
//
// Only documents whose stored value differs are written. Uses the raw
// collection driver so no Mongoose hooks (signing, body re-render, timestamps)
// fire on what is purely a counter correction.

import { Post, Reply, Circle, Group, FeedItems } from "#schema";

async function countLiveReplies(field, match = {}) {
  const rows = await Reply.collection
    .aggregate([
      { $match: { deletedAt: null, ...match } },
      { $group: { _id: `$${field}`, n: { $sum: 1 } } },
    ])
    .toArray();
  return new Map(rows.map((r) => [r._id, r.n]));
}

// Write `counts` (id -> n) onto docs in `collection`, zeroing any doc with a
// positive stored count that has no live children. Returns number fixed.
async function applyCounts(collection, counts, countPath, baseFilter = {}) {
  const ops = [];
  const cursor = collection.find(
    { ...baseFilter, $or: [{ id: { $in: [...counts.keys()] } }, { [countPath]: { $gt: 0 } }] },
    { projection: { id: 1, [countPath]: 1 } }
  );
  for await (const doc of cursor) {
    const stored = countPath.split(".").reduce((o, k) => o?.[k], doc) ?? 0;
    const actual = counts.get(doc.id) || 0;
    if (stored !== actual) {
      ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { [countPath]: actual } } } });
    }
  }
  if (ops.length) await collection.bulkWrite(ops, { ordered: false });
  return ops.length;
}

export async function recomputeCounters() {
  const result = {};

  // Post + FeedItems replyCount: total thread size (Reply.target = root).
  const byTarget = await countLiveReplies("target");
  result.posts = await applyCounts(Post.collection, byTarget, "replyCount", { deletedAt: null });
  result.feedItems = await applyCounts(FeedItems.collection, byTarget, "object.replyCount", {
    id: { $regex: /^post:/ },
  });

  // Reply.replyCount: second-level replies only (parent differs from root).
  const byParent = await countLiveReplies("parent", {
    $expr: { $ne: ["$parent", "$target"] },
  });
  result.replies = await applyCounts(Reply.collection, byParent, "replyCount", { deletedAt: null });

  // Circle.memberCount = members.length (pipeline update, drifted docs only).
  const sizeExpr = { $size: { $ifNull: ["$members", []] } };
  const c = await Circle.collection.updateMany(
    { $expr: { $ne: [{ $ifNull: ["$memberCount", 0] }, sizeExpr] } },
    [{ $set: { memberCount: sizeExpr } }]
  );
  result.circles = c.modifiedCount || 0;

  // Group.memberCount = its members circle's size.
  const groups = await Group.collection
    .aggregate([
      { $match: { deletedAt: null, "circles.members": { $type: "string" } } },
      {
        $lookup: {
          from: Circle.collection.collectionName,
          localField: "circles.members",
          foreignField: "id",
          as: "mc",
        },
      },
      { $project: { memberCount: 1, actual: { $size: { $ifNull: [{ $first: "$mc.members" }, []] } } } },
      { $match: { $expr: { $ne: ["$memberCount", "$actual"] } } },
    ])
    .toArray();
  if (groups.length) {
    await Group.collection.bulkWrite(
      groups.map((g) => ({
        updateOne: { filter: { _id: g._id }, update: { $set: { memberCount: g.actual } } },
      })),
      { ordered: false }
    );
  }
  result.groups = groups.length;

  return result;
}

const INTERVAL_MS = 24 * 60 * 60 * 1000;

// Registered from index.js alongside the other in-process workers. Idempotent,
// so running it on more than one process is harmless (just redundant).
export function startRecomputeCountersWorker() {
  const run = () =>
    recomputeCounters()
      .then((r) => console.log("[counters] Recomputed (docs fixed):", JSON.stringify(r)))
      .catch((err) => console.error("[counters] Recompute failed:", err.message));
  // Offset from GC's 1-minute startup run so the two don't contend.
  setTimeout(() => {
    run();
    setInterval(run, INTERVAL_MS);
  }, 5 * 60_000);
  console.log("[counters] Counter recompute scheduled (every 24h, first run in 5 min)");
}

export default recomputeCounters;
