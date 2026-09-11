import { TestClient } from "../helpers/client.js";

// NOTE: users here are created directly through the User model rather than
// via helpers/seedApi.js's createUser(). That helper seeds through POST
// /outbox, which cannot work under Jest: ActivityParser/index.js registers
// its verb handlers with a dynamic import() of a file:// URL, that import
// fails inside Jest's experimental ESM VM, and the registry's catch block
// swallows the error — so every activity type comes back "Unsupported
// activity type: Create". Verified as harness-only: the same parser loads
// Create fine under plain node. Auth tests don't need the activity pipeline
// anyway.

let User;

const makeUser = async (username, password) => {
  await User.create({
    id: `@${username}@kwln.org`,
    username,
    email: `${username}@kwln.org`,
    password, // pre('save') hashes it — never pre-hash here
    profile: { name: username },
  });
};

const loginAs = async (username, password) => {
  const c = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
  await c.login(username, password);
  return c;
};

beforeAll(async () => {
  ({ User } = await import("#schema"));
  await makeUser("carol", "origpassword");
  await makeUser("dave", "davepassword");
  await makeUser("erin", "erinpassword");
  await makeUser("frank", "frankpassword");
});

test("changes the password and the new one actually logs in", async () => {
  const carol = await loginAs("carol", "origpassword");

  const { status, json } = await carol.request("/auth/change-password", {
    method: "POST",
    body: {
      currentPassword: "origpassword",
      newPassword: "brandnewpassword",
    },
  });

  expect(status).toBe(200);
  expect(json.ok).toBe(true);
  // A fresh token comes back so the caller's session survives the change.
  expect(typeof json.token).toBe("string");

  // The real proof: log in from scratch with the new password...
  const relogin = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
  await expect(relogin.login("carol", "brandnewpassword")).resolves.toBeTruthy();

  // ...and the old one is dead.
  const stale = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
  await expect(stale.login("carol", "origpassword")).rejects.toBeTruthy();
});

test("rejects a wrong current password and leaves the password alone", async () => {
  const dave = await loginAs("dave", "davepassword");

  const { status, json } = await dave.request("/auth/change-password", {
    method: "POST",
    body: { currentPassword: "notitatall", newPassword: "somethingelse1" },
  });

  expect(status).toBe(400);
  expect(json.error).toMatch(/current password is incorrect/i);

  const still = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
  await expect(still.login("dave", "davepassword")).resolves.toBeTruthy();
});

test("rejects a too-short new password", async () => {
  const erin = await loginAs("erin", "erinpassword");

  const { status, json } = await erin.request("/auth/change-password", {
    method: "POST",
    body: { currentPassword: "erinpassword", newPassword: "short" },
  });

  expect(status).toBe(400);
  expect(json.error).toMatch(/at least 8 characters/i);
});

test("requires authentication", async () => {
  const anon = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
  const { status, json } = await anon.request("/auth/change-password", {
    method: "POST",
    body: { currentPassword: "origpassword", newPassword: "whateverpass" },
  });

  expect([401, 403]).toContain(status);
  expect(json.error).toBeTruthy();
});

// The account-takeover case: a scope:"visiting" token belongs to a FOREIGN
// server acting on the user's behalf via cross-server OAuth. Before this
// route existed, scope was only ever checked in routes/outbox/post.js, so
// any other authed route would have accepted one of these happily.
test("refuses a scope:visiting token", async () => {
  const { mintAccessToken } = await import("#methods/oauth/tokens.js");

  const { token } = await mintAccessToken({
    user: {
      id: "@frank@kwln.org",
      username: "frank",
      profile: { name: "frank" },
    },
    clientDomain: "evil.example",
  });

  const visitor = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
  visitor.setToken(token);

  const { status, json } = await visitor.request("/auth/change-password", {
    method: "POST",
    body: { currentPassword: "frankpassword", newPassword: "takenoveracct" },
  });

  expect(status).toBe(403);
  expect(json.error).toMatch(/visiting session/i);

  // And Frank's password is untouched.
  const frank = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
  await expect(frank.login("frank", "frankpassword")).resolves.toBeTruthy();
});
