// Perf/reliability regressions (2026-11-09):
//  - getTimeline pages through FeedFanOut by createdAt+_id cursor instead of
//    loading the viewer's whole FanOut history; every item exactly once, even
//    when many FanOut rows share one createdAt millisecond (bulk fan-out).
//  - updateMemberFetchedAt uses arrayFilters (verified via the Circle shape).
//  - GC Pass 2 batched orphan detection; GC advisory lock skips a second run.
import mongoose from "mongoose";
import { Circle, FeedItems, FeedFanOut } from "#schema";
import getTimeline from "#methods/feed/getTimeline.js";
import { runGCWithLock } from "#methods/gc/index.js";
import { getServerSettings } from "#methods/settings/schemaHelpers.js";

let domain, viewer, authorA, authorB, circleId;

beforeAll(async () => {
  domain = getServerSettings().domain;
  viewer = `@viewer@${domain}`;
  authorA = `@alpha@${domain}`;
  authorB = `@beta@${domain}`;
  const c = await Circle.create({
    actorId: viewer,
    name: "Test circle",
    to: viewer,
    members: [{ id: authorA }, { id: authorB }],
  });
  circleId = c.id;

  // 23 items. Publish times are spread out; FanOut createdAt values collide
  // in groups of 6 to exercise the _id tie-break cursor.
  const base = Date.now() - 1_000_000;
  const items = [];
  const rows = [];
  for (let i = 0; i < 23; i++) {
    const id = `post:t${i}@${domain}`;
    const actorId = i % 2 ? authorA : authorB;
    items.push({
      id,
      actorId,
      objectType: "Post",
      type: "Note",
      to: "public",
      publishedAt: new Date(base + i * 1000),
      object: { id, actorId },
    });
    rows.push({
      feedItemId: id,
      objectType: "Post",
      actorId,
      to: "@public",
      createdAt: new Date(base + Math.floor(i / 6) * 10_000),
      updatedAt: new Date(),
    });
  }
  // A Group-type item and a non-member author: both must be excluded.
  items.push({ id: `group:g@${domain}`, actorId: authorA, objectType: "Group", type: "Group", to: "public", publishedAt: new Date(), object: {} });
  rows.push({ feedItemId: `group:g@${domain}`, objectType: "Group", actorId: authorA, to: "@public", createdAt: new Date(), updatedAt: new Date() });
  items.push({ id: `post:x@${domain}`, actorId: `@other@${domain}`, objectType: "Post", type: "Note", to: "public", publishedAt: new Date(), object: {} });
  rows.push({ feedItemId: `post:x@${domain}`, objectType: "Post", actorId: `@other@${domain}`, to: "@public", createdAt: new Date(), updatedAt: new Date() });

  await FeedItems.collection.insertMany(items);
  // Raw insert so the explicit createdAt values survive (timestamps:true).
  await FeedFanOut.collection.insertMany(rows);
});

test("getTimeline pages every item exactly once with a composite cursor", async () => {
  const seen = [];
  let before = null;
  let pages = 0;
  do {
    const res = await getTimeline({ viewerId: viewer, circleId, before, limit: 5 });
    expect(res.total).toBeNull();
    // within a page, newest publishedAt first
    for (let i = 1; i < res.items.length; i++) {
      expect(new Date(res.items[i - 1].publishedAt) >= new Date(res.items[i].publishedAt)).toBe(true);
    }
    seen.push(...res.items.map((it) => it.id));
    before = res.nextCursor;
    pages++;
    if (before) expect(before).toMatch(/^\d{4}-.*Z_[0-9a-f]{24}$/);
  } while (before && pages < 20);

  expect(seen.length).toBe(23);
  expect(new Set(seen).size).toBe(23);
  expect(seen).not.toContain(`group:g@${domain}`);
  expect(seen).not.toContain(`post:x@${domain}`);
});

test("getTimeline still accepts a plain ISO `before` (legacy/mobile)", async () => {
  const res = await getTimeline({
    viewerId: viewer,
    circleId,
    before: new Date(Date.now() - 1_000_000 + 25_000).toISOString(),
    limit: 50,
  });
  // createdAt buckets 0,1,2 (i < 18) are older than base+25s
  expect(res.items.length).toBe(18);
  expect(res.nextCursor).toBeNull();
});

test("GC removes orphaned remote FeedItems (batched) and the lock blocks a re-run", async () => {
  await FeedItems.collection.insertMany([
    { id: "post:orphan@remote.example", actorId: "@r@remote.example", objectType: "Post", origin: "remote", to: "public", publishedAt: new Date(), object: {} },
    { id: "post:kept@remote.example", actorId: "@r@remote.example", objectType: "Post", origin: "remote", to: "public", publishedAt: new Date(), object: {} },
  ]);
  await FeedFanOut.collection.insertOne({
    feedItemId: "post:kept@remote.example",
    objectType: "Post",
    actorId: "@r@remote.example",
    to: viewer,
    createdAt: new Date(),
  });

  await runGCWithLock();
  expect(await FeedItems.exists({ id: "post:orphan@remote.example" })).toBeNull();
  expect(await FeedItems.exists({ id: "post:kept@remote.example" })).not.toBeNull();

  const lock = await mongoose.connection.collection("locks").findOne({ _id: "gc" });
  expect(lock.lastRunAt).toBeInstanceOf(Date);
  expect(lock.expiresAt).toBeNull();

  // Ran recently -> a second instance/run must skip (orphan re-added stays).
  await FeedItems.collection.insertOne({ id: "post:orphan2@remote.example", actorId: "@r@remote.example", objectType: "Post", origin: "remote", to: "public", publishedAt: new Date(), object: {} });
  await runGCWithLock();
  expect(await FeedItems.exists({ id: "post:orphan2@remote.example" })).not.toBeNull();
});
