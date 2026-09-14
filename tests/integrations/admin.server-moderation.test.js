import { TestClient } from "../helpers/client.js";

// Users seeded through the model, not helpers/seedApi.js — see the note in
// auth.change-password.test.js.

let FederatedServer;
let Settings;
let Circle;
let admin;

beforeAll(async () => {
  ({ FederatedServer, Settings, Circle } = await import("#schema"));

  const setting = await Settings.findOne({ name: "adminCircle" }).lean();
  await Circle.updateOne(
    { id: setting.value },
    { $addToSet: { members: { id: "@admin@kwln.org", name: "Admin" } } }
  );

  admin = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
  await admin.login("admin", "adminpass");
});

const moderate = (server, level, reason) =>
  admin.request("/admin/servers/moderate", {
    method: "POST",
    body: { server, level, ...(reason ? { reason } : {}) },
  });

test("accepts a bare domain, a URL, and an @id as the same server", async () => {
  const forms = [
    ["bare.example", "bare.example"],
    ["https://url.example/some/path", "url.example"],
    ["@atid.example", "atid.example"],
  ];

  for (const [input, expected] of forms) {
    const { status, json } = await moderate(input, "suspended");
    expect(status).toBe(201);
    expect(json.server.domain).toBe(expected);
    expect(await FederatedServer.findOne({ domain: expected }).lean()).toBeTruthy();
  }
});

test("upserts a server this one has never federated with", async () => {
  expect(await FederatedServer.findOne({ domain: "stranger.example" }).lean()).toBeNull();

  const { status } = await moderate("stranger.example", "blocked", "spam");
  expect(status).toBe(201);

  const doc = await FederatedServer.findOne({ domain: "stranger.example" }).lean();
  expect(doc.status).toBe("blocked");
  expect(doc.blockedReason).toBe("spam");
});

test("the two levels set different statuses", async () => {
  await moderate("interact.example", "blocked");
  await moderate("defed.example", "suspended");

  expect((await FederatedServer.findOne({ domain: "interact.example" }).lean()).status).toBe("blocked");
  expect((await FederatedServer.findOne({ domain: "defed.example" }).lean()).status).toBe("suspended");
});

// Suspension must stop pulls; a plain block must NOT, because local
// subscribers are supposed to keep receiving content they already follow.
test("suspension stops pulls, blocking does not", async () => {
  await moderate("pulls.example", "blocked");
  await moderate("nopulls.example", "suspended");

  const blocked = await FederatedServer.findOne({ domain: "pulls.example" }).lean();
  const suspended = await FederatedServer.findOne({ domain: "nopulls.example" }).lean();

  expect(suspended.nextPullAt).toBeNull();
  // blockServer deliberately leaves nextPullAt alone.
  expect(blocked.nextPullAt === null).toBe(false);
});

test("unmoderate puts a server back to active", async () => {
  await moderate("restore.example", "suspended");

  const { status, json } = await admin.request("/admin/servers/unmoderate", {
    method: "POST",
    body: { server: "https://restore.example" },
  });

  expect(status).toBe(200);
  expect(json.ok).toBe(true);

  const doc = await FederatedServer.findOne({ domain: "restore.example" }).lean();
  expect(doc.status).toBe("active");
  expect(doc.suspendedAt).toBeNull();
});

test("lists both levels with their reasons", async () => {
  await moderate("listed-a.example", "blocked", "because A");
  await moderate("listed-b.example", "suspended", "because B");

  const { status, json } = await admin.request("/admin/servers/moderated");
  expect(status).toBe(200);

  const byDomain = Object.fromEntries(json.servers.map((s) => [s.domain, s]));
  expect(byDomain["listed-a.example"].status).toBe("blocked");
  expect(byDomain["listed-a.example"].reason).toBe("because A");
  expect(byDomain["listed-b.example"].status).toBe("suspended");
  expect(byDomain["listed-b.example"].reason).toBe("because B");
  // Active servers must not appear.
  await FederatedServer.create({ domain: "innocent.example", status: "active" });
  const again = await admin.request("/admin/servers/moderated");
  expect(again.json.servers.find((s) => s.domain === "innocent.example")).toBeUndefined();
});

test("rejects junk input and refuses self-blocking", async () => {
  for (const junk of ["", "not a domain", "localhost", "@@@"]) {
    const { status } = await moderate(junk, "suspended");
    expect(status).toBe(400);
  }

  const bad = await moderate("ok.example", "annihilated");
  expect(bad.status).toBe(400);

  // Blocking yourself would cut every local interaction at the inbox gate.
  const self = await moderate("kwln.org", "suspended");
  expect(self.status).toBe(400);
  expect(self.json.error).toMatch(/your own server/i);
});

test("requires an admin", async () => {
  const { User } = await import("#schema");
  await User.create({
    id: "@nonadmin@kwln.org",
    username: "nonadmin",
    email: "nonadmin@kwln.org",
    password: "nonadminpw",
    profile: { name: "Not Admin" },
  });
  const plain = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
  await plain.login("nonadmin", "nonadminpw");

  const { status } = await plain.request("/admin/servers/moderate", {
    method: "POST",
    body: { server: "sneaky.example", level: "suspended" },
  });
  expect(status).toBe(403);
  expect(await FederatedServer.findOne({ domain: "sneaky.example" }).lean()).toBeNull();
});
