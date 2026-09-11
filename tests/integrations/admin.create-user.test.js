import { TestClient } from "../helpers/client.js";

// Users are seeded through the User model rather than helpers/seedApi.js —
// see the note in auth.change-password.test.js for why /outbox seeding can't
// work under Jest.

let User;
let Settings;
let Circle;
let admin;

const loginAs = async (username, password) => {
  const c = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
  await c.login(username, password);
  return c;
};

beforeAll(async () => {
  ({ User, Settings, Circle } = await import("#schema"));

  // jest.setup.js creates @admin@kwln.org but doesn't put them in the admin
  // circle, and isServerAdmin() is purely circle membership.
  const setting = await Settings.findOne({ name: "adminCircle" }).lean();
  await Circle.updateOne(
    { id: setting.value },
    { $addToSet: { members: { id: "@admin@kwln.org", name: "Admin" } } }
  );

  admin = await loginAs("admin", "adminpass");
});

test("creates a user with a supplied password that can log in", async () => {
  const { status, json } = await admin.request("/admin/users", {
    method: "POST",
    body: {
      username: "newperson",
      password: "suppliedpassword",
      email: "newperson@example.com",
      name: "New Person",
    },
  });

  expect(status).toBe(201);
  expect(json.user?.id).toBe("@newperson@kwln.org");
  // A supplied password is never echoed back.
  expect(json.generatedPassword).toBeUndefined();
  // Never leak secrets through the admin API.
  expect(json.user.password).toBeUndefined();
  expect(json.user.privateKey).toBeUndefined();

  const them = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
  await expect(them.login("newperson", "suppliedpassword")).resolves.toBeTruthy();
});

test("generates a usable password when none is supplied", async () => {
  const { status, json } = await admin.request("/admin/users", {
    method: "POST",
    body: { username: "generated_pw", name: "Generated" },
  });

  expect(status).toBe(201);
  expect(typeof json.generatedPassword).toBe("string");
  expect(json.generatedPassword.length).toBeGreaterThanOrEqual(16);

  // The generated password is the real one, not decoration.
  const them = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
  await expect(
    them.login("generated_pw", json.generatedPassword)
  ).resolves.toBeTruthy();
});

// The whole point of using User.create() rather than a raw insert: without
// the pre-save hook the account has no keys and no system circles, and can
// neither federate nor build a feed.
test("the created account is fully formed (keys + system circles)", async () => {
  await admin.request("/admin/users", {
    method: "POST",
    body: { username: "fullyformed", password: "fullyformedpw" },
  });

  const doc = await User.findOne({ id: "@fullyformed@kwln.org" }).lean();

  expect(doc.actorId).toBe("https://kwln.org/users/fullyformed");
  expect(doc.publicKey).toBeTruthy();
  expect(doc.privateKey).toBeTruthy();
  expect(doc.circles?.following).toBeTruthy();
  expect(doc.circles?.allFollowing).toBeTruthy();
  expect(doc.circles?.blocked).toBeTruthy();
  expect(doc.circles?.muted).toBeTruthy();
  // Password is stored hashed, not in the clear.
  expect(doc.password).not.toBe("fullyformedpw");
});

test("rejects a non-slug username", async () => {
  const { status, json } = await admin.request("/admin/users", {
    method: "POST",
    body: { username: "Not A Slug", password: "whateverpass" },
  });

  expect(status).toBe(400);
  expect(json.error).toMatch(/lowercase letters, numbers, or underscores/i);
});

test("rejects a duplicate username", async () => {
  await admin.request("/admin/users", {
    method: "POST",
    body: { username: "dupetarget", password: "dupetargetpw" },
  });

  const { status, json } = await admin.request("/admin/users", {
    method: "POST",
    body: { username: "dupetarget", password: "dupetargetpw" },
  });

  expect(status).toBe(409);
  expect(json.error).toMatch(/already exists/i);
});

test("rejects a too-short supplied password", async () => {
  const { status, json } = await admin.request("/admin/users", {
    method: "POST",
    body: { username: "shortpw", password: "abc" },
  });

  expect(status).toBe(400);
  expect(json.error).toMatch(/at least 8 characters/i);
});

test("refuses a non-admin", async () => {
  await User.create({
    id: "@plainuser@kwln.org",
    username: "plainuser",
    email: "plainuser@kwln.org",
    password: "plainuserpw",
    profile: { name: "Plain" },
  });
  const plain = await loginAs("plainuser", "plainuserpw");

  const { status } = await plain.request("/admin/users", {
    method: "POST",
    body: { username: "shouldnotexist", password: "shouldnotexist1" },
  });

  expect(status).toBe(403);
  expect(await User.findOne({ username: "shouldnotexist" }).lean()).toBeNull();
});

// 401 here, but 404 against a real deployment: routes/admin/index.js lets an
// unauthenticated request with no Accept header fall through to the SPA so
// browser deep-links to /admin/* render the app rather than raw JSON, and
// req.accepts(["html","json"]) answers "html" when nothing was asked for.
// buildApp() sets no frontendEnabled, so the bypass is inert in tests. Either
// way the request is refused and nothing is created — which is the part that
// matters, so assert that rather than a status that depends on deployment.
test("refuses unauthenticated", async () => {
  const anon = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
  const { status } = await anon.request("/admin/users", {
    method: "POST",
    body: { username: "anonmade", password: "anonmadepass" },
  });

  expect([401, 404]).toContain(status);
  expect(await User.findOne({ username: "anonmade" }).lean()).toBeNull();
});

// An admin's visiting token is held by a FOREIGN server. Being an admin here
// must not hand that server admin powers.
test("refuses an admin's scope:visiting token", async () => {
  const { mintAccessToken } = await import("#methods/oauth/tokens.js");
  const { token } = await mintAccessToken({
    user: {
      id: "@admin@kwln.org",
      username: "admin",
      profile: { name: "Admin" },
    },
    clientDomain: "evil.example",
  });

  const visitor = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
  visitor.setToken(token);

  const { status, json } = await visitor.request("/admin/users", {
    method: "POST",
    body: { username: "evilmade", password: "evilmadepass" },
  });

  expect(status).toBe(403);
  expect(json.error).toMatch(/visiting session/i);
  expect(await User.findOne({ username: "evilmade" }).lean()).toBeNull();
});
