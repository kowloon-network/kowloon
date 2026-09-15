import { TestClient } from "../helpers/client.js";

// GET /lookup previously had NO visibility enforcement at all — it passed
// enforceLocalVisibility: false and no canView to getObjectById, whose
// canView defaults to `async () => true` when omitted. Any authenticated
// user could fetch any local object by id regardless of its `to` audience.
// Fixed alongside wiring /lookup up to a user-facing "go to any ID" search
// feature; these tests assert the fix rather than just the happy path,
// since a passing "owner can see their own post" test would have passed
// before the fix too and said nothing about the hole.

let User, Circle, Post;
let owner, outsider;
let restrictedPostId;
let publicPostId;

beforeAll(async () => {
  ({ User, Circle, Post } = await import("#schema"));

  await User.create({
    id: "@lookup_owner@kwln.org",
    username: "lookup_owner",
    email: "lookup_owner@kwln.org",
    password: "ownerpassword1",
    profile: { name: "Owner" },
  });
  await User.create({
    id: "@lookup_outsider@kwln.org",
    username: "lookup_outsider",
    email: "lookup_outsider@kwln.org",
    password: "outsiderpassword1",
    profile: { name: "Outsider" },
  });

  const circle = await Circle.create({
    id: "circle:lookuptest0000000000001@kwln.org",
    type: "Circle",
    name: "Owner's private circle",
    actorId: "@lookup_owner@kwln.org",
    to: "@lookup_owner@kwln.org",
    members: [{ id: "@lookup_owner@kwln.org", name: "Owner" }],
  });

  const restricted = await Post.create({
    id: "post:lookuptestrestricted00001@kwln.org",
    objectType: "Post",
    type: "Note",
    actorId: "@lookup_owner@kwln.org",
    actor: { id: "@lookup_owner@kwln.org", name: "Owner" },
    to: circle.id,
    source: { content: "circle-only, outsider must not see this via lookup" },
    body: "circle-only, outsider must not see this via lookup",
  });
  restrictedPostId = restricted.id;

  const publicPost = await Post.create({
    id: "post:lookuptestpublic000000001@kwln.org",
    objectType: "Post",
    type: "Note",
    actorId: "@lookup_owner@kwln.org",
    actor: { id: "@lookup_owner@kwln.org", name: "Owner" },
    to: "@public",
    source: { content: "public post" },
    body: "public post",
  });
  publicPostId = publicPost.id;

  owner = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
  await owner.login("lookup_owner", "ownerpassword1");
  outsider = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
  await outsider.login("lookup_outsider", "outsiderpassword1");
});

test("a non-member is refused a circle-restricted post — the hole this fixes", async () => {
  const { status, json } = await outsider.request(
    `/lookup?id=${encodeURIComponent(restrictedPostId)}`
  );
  expect(status).toBe(404);
  expect(json.item).toBeUndefined();
});

test("the owner can see their own circle-restricted post via lookup", async () => {
  const { status, json } = await owner.request(
    `/lookup?id=${encodeURIComponent(restrictedPostId)}`
  );
  expect(status).toBe(200);
  expect(json.item?.id).toBe(restrictedPostId);
});

test("a public post is visible to any authenticated user via lookup", async () => {
  const { status, json } = await outsider.request(
    `/lookup?id=${encodeURIComponent(publicPostId)}`
  );
  expect(status).toBe(200);
  expect(json.item?.id).toBe(publicPostId);
});

test("requires authentication", async () => {
  const anon = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
  const { status } = await anon.request(
    `/lookup?id=${encodeURIComponent(publicPostId)}`
  );
  expect(status).toBe(401);
});

test("404s for a well-formed id that doesn't exist, not an error", async () => {
  const { status } = await owner.request(
    "/lookup?id=" + encodeURIComponent("post:doesnotexist0000000001@kwln.org")
  );
  expect(status).toBe(404);
});
