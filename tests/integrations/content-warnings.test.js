// Content warnings: stored on the post, copied into FeedItems, kept to the
// fixed category list, editable by the author, and added by a moderator in
// a way the author can't edit away.
import { User, Post, Reply, FeedItems, Settings, Circle } from "#schema";
import createActivity from "#methods/activities/create.js";
import { getServerSettings } from "#methods/settings/schemaHelpers.js";
import { TestClient } from "../helpers/client.js";

let domain, author, reader, admin;

const create = (object) =>
  createActivity({
    type: "Create",
    objectType: "Post",
    actorId: author,
    to: "@public",
    canReply: "@public",
    canReact: "@public",
    object: { type: "Note", to: "@public", ...object },
  });

const idOf = (r) => r.result?.created?.id || r.activity?.objectId;

beforeAll(async () => {
  domain = getServerSettings().domain;
  author = (await User.create({ id: `@cwauthor@${domain}`, username: "cwauthor", email: `cwauthor@${domain}`, password: "cwauthorpass", emailVerified: true })).id;
  reader = (await User.create({ id: `@cwreader@${domain}`, username: "cwreader", email: `cwreader@${domain}`, password: "cwreaderpass", emailVerified: true })).id;

  const setting = await Settings.findOne({ name: "adminCircle" }).lean();
  await Circle.updateOne(
    { id: setting.value },
    { $addToSet: { members: { id: `@admin@${domain}`, name: "Admin" } } }
  );
  admin = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
  await admin.login("admin", "adminpass");
}, 60000);

test("a warning is stored on the post and copied to its feed entry", async () => {
  const r = await create({
    source: { content: "the ending" },
    contentWarning: { categories: ["spoilers", "nonsense"], note: "  Severance\nS2 " },
    sensitive: true,
  });
  expect(r.error).toBeUndefined();
  const id = idOf(r);

  const post = await Post.findOne({ id }).lean();
  expect(post.contentWarning.categories).toEqual(["spoilers"]);
  expect(post.contentWarning.note).toBe("Severance S2");
  expect(post.contentWarning.addedBy).toBeUndefined();
  expect(post.sensitive).toBe(true);

  const item = await FeedItems.findOne({ id }).lean();
  expect(item.object.contentWarning.categories).toEqual(["spoilers"]);
  expect(item.object.sensitive).toBe(true);
});

test("a client can't pretend a moderator added the warning", async () => {
  const r = await create({
    source: { content: "x" },
    contentWarning: { categories: ["violence"], addedBy: "@admin@kwln.org" },
  });
  const post = await Post.findOne({ id: idOf(r) }).lean();
  expect(post.contentWarning.addedBy).toBeUndefined();
});

test("a post without a warning has none", async () => {
  const r = await create({ source: { content: "nice day" }, contentWarning: { categories: [], note: "" } });
  const post = await Post.findOne({ id: idOf(r) }).lean();
  expect(post.contentWarning).toBeUndefined();
  expect(post.sensitive).toBe(false);
});

test("the author can change and remove their warning", async () => {
  const id = idOf(await create({ source: { content: "y" }, contentWarning: { categories: ["death"] } }));
  const upd = (object) =>
    createActivity({ type: "Update", objectType: "Post", actorId: author, target: id, object });

  expect((await upd({ contentWarning: { categories: ["death", "medical"] } })).error).toBeUndefined();
  expect((await Post.findOne({ id }).lean()).contentWarning.categories).toEqual(["death", "medical"]);
  expect((await FeedItems.findOne({ id }).lean()).object.contentWarning.categories).toEqual(["death", "medical"]);

  await upd({ contentWarning: null });
  expect((await Post.findOne({ id }).lean()).contentWarning).toBeNull();
});

test("a reply keeps the warning it was sent with", async () => {
  const parent = idOf(await create({ source: { content: "parent" } }));
  const r = await createActivity({
    type: "Reply",
    objectType: "Reply",
    actorId: reader,
    to: parent,
    object: { type: "Reply", source: { content: "about the ending" }, contentWarning: { categories: ["spoilers"] } },
  });
  expect(r.error).toBeUndefined();
  const reply = await Reply.findOne({ target: parent, actorId: reader }).lean();
  expect(reply.contentWarning.categories).toEqual(["spoilers"]);
});

test("a moderator's warning sticks, and the author is told", async () => {
  const id = idOf(await create({ source: { content: "graphic" } }));

  const res = await admin.request("/admin/content-warning", {
    method: "POST",
    body: { target: id, contentWarning: { categories: ["violence"] }, sensitive: true },
  });
  expect(res.status).toBe(200);
  const post = await Post.findOne({ id }).lean();
  expect(post.contentWarning.categories).toEqual(["violence"]);
  expect(post.contentWarning.addedBy).toBe(`@admin@${domain}`);
  expect((await FeedItems.findOne({ id }).lean()).object.contentWarning.addedBy).toBe(`@admin@${domain}`);

  // The author edits the post and tries to drop the warning: it stays.
  await createActivity({
    type: "Update",
    objectType: "Post",
    actorId: author,
    target: id,
    object: { source: { content: "graphic, edited" }, contentWarning: null, sensitive: false },
  });
  const after = await Post.findOne({ id }).lean();
  expect(after.contentWarning.categories).toEqual(["violence"]);
  expect(after.sensitive).toBe(true);
  expect(after.source.content).toBe("graphic, edited");

  const { Notification } = await import("#schema");
  const n = await Notification.findOne({ recipientId: author, type: "moderation" }).lean();
  expect(n.summary).toMatch(/content warning/);
});

test("ordinary members can't use the moderator route", async () => {
  const c = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
  await c.login("cwreader", "cwreaderpass");
  const res = await c.request("/admin/content-warning", {
    method: "POST",
    body: { target: "post:000000000000000000000000@kwln.org", contentWarning: { categories: ["violence"] } },
  });
  expect(res.status).toBe(403);
});

test("reader choices save per category without resetting the others", async () => {
  const upd = (prefs) =>
    createActivity({ type: "Update", objectType: "User", actorId: reader, target: reader, object: { prefs } });
  await upd({ contentWarnings: { spoilers: "show" } });
  await upd({ contentWarnings: { violence: "hide", sexual: "bogus" } });
  const u = await User.findOne({ id: reader }).lean();
  expect(u.prefs.contentWarnings.spoilers).toBe("show");
  expect(u.prefs.contentWarnings.violence).toBe("hide");
  expect(u.prefs.contentWarnings.sexual).toBe("warn");
});
