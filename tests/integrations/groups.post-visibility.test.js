// Group-addressed posts must be visible to the group's members, not only to
// the author. Regression test for: FeedItems.to is coarsened to "audience" for
// any group:<id> address, canView("audience") only consulted FeedFanOut
// {to: viewerId}, while enqueueFanOut wrote public/server group posts as ONE
// row with to:"@public"/"@server" and private groups read the nonexistent
// `group.members` (members live in the Circle at group.circles.members).
import { TestClient } from "../helpers/client.js";
import { User, Group } from "#schema";
import createActivity from "#methods/activities/create.js";
import { getServerSettings } from "#methods/settings/schemaHelpers.js";

let domain, author, member, outsider;
let authorC, memberC, outsiderC;

async function mkUser(username) {
  const u = await User.create({
    id: `@${username}@${domain}`,
    username,
    email: `${username}@${domain}`,
    password: "pw",
    profile: { name: username },
  });
  return u.id;
}

async function mkGroup(to, rsvpPolicy = "open") {
  const r = await createActivity({
    type: "Create",
    objectType: "Group",
    actorId: author,
    to,
    canReply: to,
    canReact: to,
    object: { type: "Group", name: `G ${to}`, summary: "x", rsvpPolicy, to },
  });
  if (r.error) throw new Error("group create: " + r.error);
  const gid = r.result?.created?.id || r.activity?.objectId;
  const g = await Group.findOne({ id: gid }).lean();
  // Fix up `to` explicitly in case the handler canonicalized it differently.
  if (g.to !== to) await Group.updateOne({ id: gid }, { $set: { to } });
  return gid;
}

async function join(actorId, groupId) {
  const r = await createActivity({
    type: "Join",
    objectType: "Group",
    actorId,
    to: groupId,
    target: groupId,
    object: { id: groupId },
  });
  if (r.error) throw new Error("join: " + r.error);
}

async function mkPost(groupId) {
  const r = await createActivity({
    type: "Create",
    objectType: "Post",
    actorId: author,
    to: groupId,
    canReply: groupId,
    canReact: groupId,
    object: { type: "Note", source: { content: "hello group" }, to: groupId },
  });
  if (r.error) throw new Error("post create: " + r.error);
  return r.result?.created?.id || r.activity?.objectId;
}

beforeAll(async () => {
  domain = getServerSettings().domain;
  author = await mkUser("gauthor");
  member = await mkUser("gmember");
  outsider = await mkUser("goutsider");
  const base = global.__TEST_BASE_URL__;
  authorC = new TestClient({ baseURL: base });
  memberC = new TestClient({ baseURL: base });
  outsiderC = new TestClient({ baseURL: base });
  await authorC.login("gauthor", "pw");
  await memberC.login("gmember", "pw");
  await outsiderC.login("goutsider", "pw");
}, 60000);

const get = (c, id) => c.request(`/posts/${encodeURIComponent(id)}`);

test("public group post is visible to a member (and to anyone)", async () => {
  const gid = await mkGroup("@public");
  await join(member, gid);
  const pid = await mkPost(gid);
  expect(pid).toBeTruthy();
  expect((await get(authorC, pid)).status).toBe(200);
  expect((await get(memberC, pid)).status).toBe(200);
  expect((await get(outsiderC, pid)).status).toBe(200);
});

test("private group post is visible to members but not outsiders", async () => {
  const gid = await mkGroup(author);
  await join(member, gid);
  const pid = await mkPost(gid);
  expect(pid).toBeTruthy();
  expect((await get(authorC, pid)).status).toBe(200);
  expect((await get(memberC, pid)).status).toBe(200);
  expect((await get(outsiderC, pid)).status).toBe(403);
});

test("private group: a member who joins AFTER the post can see it", async () => {
  const gid = await mkGroup(author);
  const pid = await mkPost(gid);
  expect((await get(outsiderC, pid)).status).toBe(403);
  await join(outsider, gid);
  expect((await get(outsiderC, pid)).status).toBe(200);
});
