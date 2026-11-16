import { TestClient } from "../helpers/client.js";
import {
  seedAdminAndLogin,
  createUser,
  createGroup,
} from "../helpers/seedApi.js";

let admin, alice, bob, carol;

beforeAll(async () => {
  admin = await seedAdminAndLogin();

  // Create test users
  await createUser(admin, { username: "alice", password: "pw", name: "Alice" });
  await createUser(admin, { username: "bob", password: "pw", name: "Bob" });
  await createUser(admin, {
    username: "carol",
    password: "pw",
    name: "Carol",
  });

  alice = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
  await alice.login("alice", "pw");

  bob = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
  await bob.login("bob", "pw");

  carol = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
  await carol.login("carol", "pw");
});

describe("Posts Collection Visibility", () => {
  let publicPostId, domainPostId, circlePostId;

  beforeAll(async () => {
    // Alice creates a public post
    const publicPost = await alice.postOutbox({
      type: "Create",
      objectType: "Post",
      object: {
        type: "Note",
        title: "Public Post",
        content: "Everyone can see this",
      },
      to: "@public",
    });
    publicPostId =
      publicPost.json?.result?.id ||
      publicPost.json?.activity?.objectId ||
      publicPost.json?.item?.id ||
      publicPost.json?.id;

    // Alice creates a domain-scoped post
    const domainPost = await alice.postOutbox({
      type: "Create",
      objectType: "Post",
      object: {
        type: "Note",
        title: "Domain Post",
        content: "Only kwln.org users can see this",
      },
      to: "@kwln.org",
    });
    domainPostId =
      domainPost.json?.result?.id ||
      domainPost.json?.activity?.objectId ||
      domainPost.json?.item?.id ||
      domainPost.json?.id;

    // Alice creates a circle to share with Bob
    const circleCreate = await alice.postOutbox({
      type: "Create",
      objectType: "Circle",
      object: { type: "Circle",
        name: "Friends",
        members: [{ id: "@alice@kwln.org" }, { id: "@bob@kwln.org" }],
      },
      to: "@alice@kwln.org",
    });
    const circleId =
      circleCreate.json?.result?.id ||
      circleCreate.json?.activity?.objectId ||
      circleCreate.json?.item?.id ||
      circleCreate.json?.id;

    // Alice creates a circle-scoped post
    const circlePost = await alice.postOutbox({
      type: "Create",
      objectType: "Post",
      object: {
        type: "Note",
        title: "Circle Post",
        content: "Only circle members can see this",
      },
      to: circleId,
    });
    circlePostId =
      circlePost.json?.result?.id ||
      circlePost.json?.activity?.objectId ||
      circlePost.json?.item?.id ||
      circlePost.json?.id;
  });

  test("Anonymous user sees only public posts", async () => {
    const anon = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
    const { status, json } = await anon.request("/posts");

    expect(status).toBe(200);
    expect(json.orderedItems || json.items).toBeDefined();

    // Should see public post
    const publicPost = (json.orderedItems || json.items).find((p) => p.id === publicPostId);
    expect(publicPost).toBeDefined();
    expect(publicPost.title).toBe("Public Post");

    // Should NOT see domain-scoped post
    const domainPost = (json.orderedItems || json.items).find((p) => p.id === domainPostId);
    expect(domainPost).toBeUndefined();

    // Should NOT see circle-scoped post
    const circlePost = (json.orderedItems || json.items).find((p) => p.id === circlePostId);
    expect(circlePost).toBeUndefined();
  });

  test("Authenticated user (Bob) sees public and domain posts", async () => {
    const { status, json } = await bob.request("/posts");

    expect(status).toBe(200);

    // Should see public post
    const publicPost = (json.orderedItems || json.items).find((p) => p.id === publicPostId);
    expect(publicPost).toBeDefined();

    // Should see domain-scoped post (same domain)
    const domainPost = (json.orderedItems || json.items).find((p) => p.id === domainPostId);
    expect(domainPost).toBeDefined();
    expect(domainPost.title).toBe("Domain Post");
  });

  // GET /posts is the server firehose: public and server-wide posts only.
  // Circle posts never appear in it, even for members -- they reach members
  // through their own feeds, and open directly by ID.
  test("Circle member (Bob) opens a circle post, but it stays out of the firehose", async () => {
    const { status, json } = await bob.request("/posts");
    expect(status).toBe(200);
    expect((json.orderedItems || json.items).find((p) => p.id === circlePostId)).toBeUndefined();

    const one = await bob.request(`/posts/${encodeURIComponent(circlePostId)}`);
    expect(one.status).toBe(200);
    expect(one.json.title).toBe("Circle Post");
  });

  test("Non-circle member (Carol) does NOT see circle-scoped posts", async () => {
    const { status, json } = await carol.request("/posts");

    expect(status).toBe(200);

    // Should see public post
    const publicPost = (json.orderedItems || json.items).find((p) => p.id === publicPostId);
    expect(publicPost).toBeDefined();

    // Should see domain post
    const domainPost = (json.orderedItems || json.items).find((p) => p.id === domainPostId);
    expect(domainPost).toBeDefined();

    // Should NOT see circle post (Carol is not in the circle)
    const circlePost = (json.orderedItems || json.items).find((p) => p.id === circlePostId);
    expect(circlePost).toBeUndefined();
  });
});

describe("Individual Post Visibility", () => {
  let publicPostId, circlePostId;

  beforeAll(async () => {
    // Alice creates a public post
    const publicPost = await alice.postOutbox({
      type: "Create",
      objectType: "Post",
      object: { type: "Note", title: "Public", content: "Public content" },
      to: "@public",
    });
    publicPostId =
      publicPost.json?.result?.id ||
      publicPost.json?.activity?.objectId ||
      publicPost.json?.item?.id ||
      publicPost.json?.id;

    // Alice creates a circle
    const circleCreate = await alice.postOutbox({
      type: "Create",
      objectType: "Circle",
      object: { type: "Circle",
        name: "Private Circle",
        members: [{ id: "@alice@kwln.org" }],
      },
      to: "@alice@kwln.org",
    });
    const circleId =
      circleCreate.json?.result?.id ||
      circleCreate.json?.activity?.objectId ||
      circleCreate.json?.item?.id ||
      circleCreate.json?.id;

    // Alice creates a circle-scoped post
    const circlePost = await alice.postOutbox({
      type: "Create",
      objectType: "Post",
      object: {
        type: "Note",
        title: "Private",
        content: "Private content",
      },
      to: circleId,
    });
    circlePostId =
      circlePost.json?.result?.id ||
      circlePost.json?.activity?.objectId ||
      circlePost.json?.item?.id ||
      circlePost.json?.id;
  });

  test("Anonymous user can fetch public post by ID", async () => {
    const anon = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
    const { status, json } = await anon.request(
      `/posts/${encodeURIComponent(publicPostId)}`
    );

    expect(status).toBe(200);
    expect(json.id).toBeDefined();
    expect(json.title).toBe("Public");
  });

  test("Anonymous user cannot fetch circle-scoped post by ID", async () => {
    const anon = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
    const { status, json } = await anon.request(
      `/posts/${encodeURIComponent(circlePostId)}`
    );

    expect([401, 403, 404]).toContain(status);
  });

  test("The author can fetch their circle-scoped post by ID", async () => {
    const { status, json } = await alice.request(
      `/posts/${encodeURIComponent(circlePostId)}`
    );

    expect(status).toBe(200);
    expect(json.id).toBeDefined();
    expect(json.title).toBe("Private");
  });

  test("Non-circle member cannot fetch circle-scoped post by ID", async () => {
    const { status } = await bob.request(
      `/posts/${encodeURIComponent(circlePostId)}`
    );

    expect([401, 403, 404]).toContain(status);
  });
});

describe("Groups Collection Visibility", () => {
  let publicGroupId, domainGroupId, circleGroupId;

  beforeAll(async () => {
    // Alice creates a public group
    const publicGroup = await alice.postOutbox({
      type: "Create",
      objectType: "Group",
      object: { type: "Group", name: "Public Group", summary: "Everyone can see" },
      to: "@public",
    });
    publicGroupId =
      publicGroup.json?.result?.id ||
      publicGroup.json?.activity?.objectId ||
      publicGroup.json?.item?.id ||
      publicGroup.json?.id;

    // Alice creates a domain-scoped group
    const domainGroup = await alice.postOutbox({
      type: "Create",
      objectType: "Group",
      object: { type: "Group",
        name: "Domain Group",
        summary: "Only kwln.org users",
      },
      to: "@kwln.org",
    });
    domainGroupId =
      domainGroup.json?.result?.id ||
      domainGroup.json?.activity?.objectId ||
      domainGroup.json?.item?.id ||
      domainGroup.json?.id;

    // Alice creates a circle
    const circleCreate = await alice.postOutbox({
      type: "Create",
      objectType: "Circle",
      object: { type: "Circle",
        name: "Admin Circle",
        members: [{ id: "@alice@kwln.org" }],
      },
      to: "@alice@kwln.org",
    });
    const circleId =
      circleCreate.json?.result?.id ||
      circleCreate.json?.activity?.objectId ||
      circleCreate.json?.item?.id ||
      circleCreate.json?.id;

    // Alice creates a circle-scoped group
    const circleGroup = await alice.postOutbox({
      type: "Create",
      objectType: "Group",
      object: { type: "Group", name: "Secret Group", summary: "Circle members only" },
      to: circleId,
    });
    circleGroupId =
      circleGroup.json?.result?.id ||
      circleGroup.json?.activity?.objectId ||
      circleGroup.json?.item?.id ||
      circleGroup.json?.id;
  });

  test("Anonymous user sees only public groups", async () => {
    const anon = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
    const { status, json } = await anon.request("/groups");

    expect(status).toBe(200);

    // Should see public group
    const publicGroup = (json.orderedItems || json.items).find((g) => g.id === publicGroupId);
    expect(publicGroup).toBeDefined();

    // Should NOT see domain-scoped group
    const domainGroup = (json.orderedItems || json.items).find((g) => g.id === domainGroupId);
    expect(domainGroup).toBeUndefined();

    // Should NOT see circle-scoped group
    const circleGroup = (json.orderedItems || json.items).find((g) => g.id === circleGroupId);
    expect(circleGroup).toBeUndefined();
  });

  test("Authenticated user sees public and domain groups", async () => {
    const { status, json } = await bob.request("/groups");

    expect(status).toBe(200);

    // Should see public group
    const publicGroup = (json.orderedItems || json.items).find((g) => g.id === publicGroupId);
    expect(publicGroup).toBeDefined();

    // Should see domain group
    const domainGroup = (json.orderedItems || json.items).find((g) => g.id === domainGroupId);
    expect(domainGroup).toBeDefined();

    // Should NOT see circle group (Bob not in circle)
    const circleGroup = (json.orderedItems || json.items).find((g) => g.id === circleGroupId);
    expect(circleGroup).toBeUndefined();
  });

  test("Circle member sees circle-scoped groups", async () => {
    const { status, json } = await alice.request("/groups");

    expect(status).toBe(200);

    // Alice should see all groups including the circle-scoped one
    const circleGroup = (json.orderedItems || json.items).find((g) => g.id === circleGroupId);
    expect(circleGroup).toBeDefined();
  });
});

describe("Blocked Users Filtering", () => {
  let blockedUserId, blockedPostId;

  beforeAll(async () => {
    // Create a user that Alice will block
    await createUser(admin, {
      username: "spammer",
      password: "pw",
      name: "Spammer",
    });
    blockedUserId = "@spammer@kwln.org";

    const spammer = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
    await spammer.login("spammer", "pw");

    // Spammer creates a public post
    const spamPost = await spammer.postOutbox({
      type: "Create",
      objectType: "Post",
      object: { type: "Note", title: "Spam", content: "Buy now!" },
      to: "@public",
    });
    blockedPostId =
      spamPost.json?.result?.id ||
      spamPost.json?.activity?.objectId ||
      spamPost.json?.item?.id ||
      spamPost.json?.id;

    // Alice blocks the spammer
    await alice.postOutbox({
      type: "Block",
      target: blockedUserId,
      to: "@alice@kwln.org",
    });
  });

  test("Blocked user's posts are filtered from Alice's feed", async () => {
    const { status, json } = await alice.request("/posts");

    expect(status).toBe(200);

    // Alice should NOT see the spammer's post
    const blockedPost = (json.orderedItems || json.items).find((p) => p.id === blockedPostId);
    expect(blockedPost).toBeUndefined();
  });

  test("Other users can still see blocked user's posts", async () => {
    const { status, json } = await bob.request("/posts");

    expect(status).toBe(200);

    // Bob can still see the spammer's post
    const spamPost = (json.orderedItems || json.items).find((p) => p.id === blockedPostId);
    expect(spamPost).toBeDefined();
  });
});
