import { TestClient } from "../helpers/client.js";

// Users are created directly (see auth.change-password.test.js for why the
// outbox can't seed them under Jest).

let User;

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

beforeAll(async () => {
  ({ User } = await import("#schema"));
  await makeUser("gina", "ginapassword");
  await makeUser("hank", "hankpassword");
  await makeUser("iris", "irispassword");
});

test("changes the email with the right password, and marks it unverified", async () => {
  const gina = await loginAs("gina", "ginapassword");
  const { status, json } = await gina.request("/auth/change-email", {
    method: "POST",
    body: { password: "ginapassword", email: "  Gina.New@Example.com " },
  });
  expect(status).toBe(200);
  expect(json.ok).toBe(true);
  expect(json.email).toBe("gina.new@example.com");

  const doc = await User.findOne({ id: "@gina@kwln.org" }).select("+emailVerificationToken").lean();
  expect(doc.email).toBe("gina.new@example.com");
  expect(doc.emailVerified).toBe(false);
  expect(typeof doc.emailVerificationToken).toBe("string");

  // /auth/me shows you your own email.
  const me = await gina.request("/auth/me");
  expect(me.json.user.email).toBe("gina.new@example.com");
  expect(me.json.user.emailVerified).toBe(false);
});

test("refuses a wrong password and leaves the email alone", async () => {
  const hank = await loginAs("hank", "hankpassword");
  const { status, json } = await hank.request("/auth/change-email", {
    method: "POST",
    body: { password: "wrongwrong", email: "hank2@example.com" },
  });
  expect(status).toBe(400);
  expect(json.error).toMatch(/incorrect password/i);
  const doc = await User.findOne({ id: "@hank@kwln.org" }).lean();
  expect(doc.email).toBe("hank@kwln.org");
});

test("refuses an address another account already uses", async () => {
  const iris = await loginAs("iris", "irispassword");
  const { status } = await iris.request("/auth/change-email", {
    method: "POST",
    body: { password: "irispassword", email: "hank@kwln.org" },
  });
  expect(status).toBe(409);
});

test("refuses a malformed address", async () => {
  const iris = await loginAs("iris", "irispassword");
  const { status } = await iris.request("/auth/change-email", {
    method: "POST",
    body: { password: "irispassword", email: "not-an-email" },
  });
  expect(status).toBe(400);
});
