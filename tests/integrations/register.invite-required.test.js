import { TestClient } from "../helpers/client.js";

// Registration always requires a valid invite code now — there is no
// server-wide open-signup switch. Users seeded through the model, not
// helpers/seedApi.js — see the note in auth.change-password.test.js for why
// /outbox seeding can't work under Jest.

let Settings;
let Circle;
let admin;

beforeAll(async () => {
  ({ Settings, Circle } = await import("#schema"));

  const setting = await Settings.findOne({ name: "adminCircle" }).lean();
  await Circle.updateOne(
    { id: setting.value },
    { $addToSet: { members: { id: "@admin@kwln.org", name: "Admin" } } }
  );

  admin = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
  await admin.login("admin", "adminpass");
});

const createInvite = async (body) => {
  const { json } = await admin.request("/admin/invites", {
    method: "POST",
    body,
  });
  return json.invite;
};

const register = (body) => {
  const c = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
  return c.request("/register", { method: "POST", body }).then((r) => ({
    ...r,
    client: c,
  }));
};

test("refuses registration with no invite code at all", async () => {
  const { status, json } = await register({
    username: "noinviteatall",
    password: "somepassword1",
  });

  expect(status).toBe(403);
  expect(json.error).toMatch(/invite code/i);
});

test("refuses an invite code that doesn't exist", async () => {
  const { status, json } = await register({
    username: "bogusinvite",
    password: "somepassword1",
    inviteCode: "not-a-real-code",
  });

  expect(status).toBe(404);
  expect(json.error).toMatch(/invalid invite/i);
});

test("an unlimited 'open' invite registers real accounts and is never exhausted", async () => {
  const invite = await createInvite({ type: "open", note: "test" });
  expect(invite.maxRedemptions).toBeNull();

  const first = await register({
    username: "openinviteuser1",
    password: "somepassword1",
    inviteCode: invite.code,
  });
  expect(first.status).toBe(201);
  expect(first.json.user?.id).toBe("@openinviteuser1@kwln.org");
  expect(first.json.token).toBeTruthy();

  // The same unlimited code works again — this is the whole point of an
  // "open" invite standing in for the old server-wide toggle.
  const second = await register({
    username: "openinviteuser2",
    password: "somepassword1",
    inviteCode: invite.code,
  });
  expect(second.status).toBe(201);
});

test("a maxRedemptions:1 open invite is exhausted after one use", async () => {
  const invite = await createInvite({ type: "open", maxRedemptions: 1 });

  const first = await register({
    username: "cappedinviteuser",
    password: "somepassword1",
    inviteCode: invite.code,
  });
  expect(first.status).toBe(201);

  const second = await register({
    username: "cappedinviteuser2",
    password: "somepassword1",
    inviteCode: invite.code,
  });
  expect(second.status).toBe(410);
  expect(second.json.error).toMatch(/redemption limit/i);
});

test("an individual invite only works for its own email", async () => {
  const invite = await createInvite({
    type: "individual",
    email: "invited-person@example.com",
  });

  const wrongEmail = await register({
    username: "wrongemailuser",
    password: "somepassword1",
    email: "someone-else@example.com",
    inviteCode: invite.code,
  });
  expect(wrongEmail.status).toBe(403);
  expect(wrongEmail.json.error).toMatch(/different email/i);

  const rightEmail = await register({
    username: "rightemailuser",
    password: "somepassword1",
    email: "invited-person@example.com",
    inviteCode: invite.code,
  });
  expect(rightEmail.status).toBe(201);

  // Individual invites are single-use — a second registration attempt with
  // the same code, even with the right email, is refused.
  const reused = await register({
    username: "rightemailuser2",
    password: "somepassword1",
    email: "invited-person@example.com",
    inviteCode: invite.code,
  });
  expect(reused.status).toBe(410);
  expect(reused.json.error).toMatch(/already been used/i);
});

// The federation-facing fields must keep reporting accurately now that
// there's no per-server flag behind them — false, not absent.
//
// NodeInfo isn't covered here, and NOT because of a harness quirk as
// originally assumed. Verified live against kwln.dev: GET /nodeinfo/2.0
// returns the SPA's index.html, not JSON, in the real deployed server too.
// routes/well-known/index.js mounts nodeinfo20.js via
// router.use("/../nodeinfo/2.0", nodeinfo20) — a relative-path trick meant to
// serve it outside the /.well-known prefix — but Express mount paths are
// plain string prefixes, not filesystem-style paths, so a literal "/../"
// segment is very unlikely to ever match a real incoming request path; it
// silently falls through to the SPA catch-all every time. This predates the
// invite-code change entirely (unchanged since eb251e31) and is a real,
// separate federation-discovery bug — NodeInfo is unreachable on every
// Kowloon server right now. Flagged, deliberately NOT fixed here (out of
// scope for this change) — filed as its own follow-up.
test("the public profile reports openRegistrations: false", async () => {
  const profile = await admin.request("/profile");
  expect(profile.json.openRegistrations).toBe(false);
});

// /config.json (the frontend's runtime-config bootstrap) no longer carries a
// registrationIsOpen key at all — there is nothing for the frontend to read.
test("/config.json no longer exposes registrationIsOpen", async () => {
  const { json } = await admin.request("/config.json");
  expect(json).not.toHaveProperty("registrationIsOpen");
});
