import { TestClient } from "../helpers/client.js";

// Users are created directly (see auth.change-password.test.js for why the
// outbox can't seed them under Jest).

let User, ExportJob;

const makeUser = async (username, password) => {
  await User.create({
    id: `@${username}@kwln.org`,
    username,
    email: `${username}@kwln.org`,
    emailVerified: true,
    password,
    profile: { name: username },
  });
};

const loginAs = async (username, password) => {
  const c = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
  await c.login(username, password);
  return c;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  ({ User, ExportJob } = await import("#schema"));
  await makeUser("jack", "jackpassword");
  await makeUser("kate", "katepassword");
});

test("sign out everywhere ends other sessions and keeps this one", async () => {
  const phone = await loginAs("jack", "jackpassword");
  await sleep(1100); // tokens carry a 1-second issue time
  const laptop = await loginAs("jack", "jackpassword");
  await sleep(1100);

  const { status, json } = await laptop.request("/auth/sign-out-everywhere", { method: "POST" });
  expect(status).toBe(200);
  expect(typeof json.token).toBe("string");

  // The other device is out.
  expect((await phone.request("/auth/me")).status).toBe(401);

  // This device carries on with the fresh token.
  const fresh = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
  fresh.token = json.token;
  const me = await fresh.request("/auth/me");
  expect(me.status).toBe(200);
  expect(me.json.user.id).toBe("@jack@kwln.org");
});

test("asking for a data export queues one, and only one an hour", async () => {
  const kate = await loginAs("kate", "katepassword");

  expect((await kate.request("/auth/export")).json.export).toBeNull();

  const first = await kate.request("/auth/export", { method: "POST" });
  expect(first.status).toBe(202);
  expect(first.json.export.status).toBe("pending");

  // Asking again while it's queued returns the same job.
  const again = await kate.request("/auth/export", { method: "POST" });
  expect(again.status).toBe(202);
  expect(await ExportJob.countDocuments({ actorId: "@kate@kwln.org" })).toBe(1);

  const st = await kate.request("/auth/export");
  expect(st.json.export.status).toBe("pending");
  expect(st.json.export.downloadUrl).toBeUndefined();

  // Once it's finished, a new request within the hour is refused.
  await ExportJob.updateOne({ actorId: "@kate@kwln.org" }, { $set: { status: "failed", error: "x" } });
  const tooSoon = await kate.request("/auth/export", { method: "POST" });
  expect(tooSoon.status).toBe(429);
});

test("a download link must be signed", async () => {
  const c = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
  const job = await ExportJob.findOne({ actorId: "@kate@kwln.org" }).lean();
  const r = await c.request(`/auth/export/download?job=${job._id}&exp=9999999999&sig=forged`);
  expect(r.status).toBe(403);
});

test("export status needs a session", async () => {
  const c = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
  expect((await c.request("/auth/export")).status).toBe(401);
});
