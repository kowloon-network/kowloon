// React handler: one reaction per (actorId, target) under concurrency, and
// createActivity idempotency (dedupeKey) under concurrency -- both rely on
// unique indexes, so build them explicitly (the harness drops the DB after
// Mongoose's autoIndex already ran).
import { User, Post, React, Activity } from "#schema";
import createActivity from "#methods/activities/create.js";
import { getServerSettings } from "#methods/settings/schemaHelpers.js";

let domain, alice, bob, postId;

beforeAll(async () => {
  await React.createIndexes();
  await Activity.createIndexes();
  domain = getServerSettings().domain;
  alice = (await User.create({ id: `@ralice@${domain}`, username: "ralice", email: `ralice@${domain}`, password: "pw" })).id;
  bob = (await User.create({ id: `@rbob@${domain}`, username: "rbob", email: `rbob@${domain}`, password: "pw" })).id;
  const r = await createActivity({
    type: "Create",
    objectType: "Post",
    actorId: alice,
    to: "@public",
    canReply: "@public",
    canReact: "@public",
    object: { type: "Note", source: { content: "react to me" }, to: "@public" },
  });
  if (r.error) throw new Error(r.error);
  postId = r.result?.created?.id || r.activity?.objectId;
}, 60000);

const react = (emoji) =>
  createActivity({
    type: "React",
    objectType: "React",
    actorId: bob,
    to: postId,
    object: emoji ? { type: "React", emoji, name: emoji } : { emoji: "" }, // mirrors client clear payload
  });

test("concurrent identical reacts produce exactly one React doc", async () => {
  const results = await Promise.all([react("👍"), react("👍"), react("👍"), react("👍")]);
  for (const r of results) expect(r.error).toBeUndefined();
  const docs = await React.find({ actorId: bob, target: postId }).lean();
  expect(docs).toHaveLength(1);
  expect(docs[0].id).toMatch(/^react:[0-9a-f]{24}@/);
  expect(docs[0].id).toBe(`react:${docs[0]._id}@${domain}`);
  const post = await Post.findOne({ id: postId }).lean();
  expect(post.reactCount).toBe(1);
});

test("changing emoji replaces, clearing removes", async () => {
  const r = await react("🎉");
  expect(r.result?.result?.status ?? r.result?.status).toBe("replaced");
  let docs = await React.find({ actorId: bob, target: postId }).lean();
  expect(docs.map((d) => d.emoji)).toEqual(["🎉"]);
  const c = await react(null);
  expect(c.result?.result?.status ?? c.result?.status).toBe("unreacted");
  docs = await React.find({ actorId: bob, target: postId }).lean();
  expect(docs).toHaveLength(0);
  expect((await Post.findOne({ id: postId }).lean()).reactCount).toBe(0);
});

test("concurrent creates with the same dedupeKey are idempotent (no error)", async () => {
  const mk = () =>
    createActivity({
      type: "Create",
      objectType: "Post",
      actorId: alice,
      to: "@public",
      canReply: "@public",
      canReact: "@public",
      dedupeKey: "same-key-1",
      object: { type: "Note", source: { content: "once" }, to: "@public" },
    });
  const results = await Promise.all([mk(), mk(), mk()]);
  for (const r of results) expect(r.error).toBeUndefined();
  expect(await Activity.countDocuments({ actorId: alice, dedupeKey: "same-key-1" })).toBe(1);
});
