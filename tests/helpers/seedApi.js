import { TestClient } from "./client.js";

export async function seedAdminAndLogin() {
  const baseURL = global.__TEST_BASE_URL__;
  const client = new TestClient({ baseURL });

  // Create admin via direct model or via a bootstrap endpoint.
  // If you already have an init path that creates an admin, call login here:
  const username = "admin";
  const password = "adminpass";

  // Try login; if fails, create via outbox "Create Person"
  let loginOk = false;
  try {
    await client.login(username, password);
    loginOk = true;
  } catch (e) {
    /* fall through to create */
  }

  if (!loginOk) {
    // Create user via Activity (your ActivityParser should create the user).
    // objectType/object.type must be "User" — "Person" isn't in the activity
    // schema's allowed-values enum, and object.type is required by an
    // if/then schema rule specific to Create->User.
    await client.postOutbox({
      type: "Create",
      objectType: "User",
      object: {
        type: "User",
        username,
        password,
        profile: { name: "Admin" },
      },
      to: "@kwln.org",
    });
    await client.login(username, password);
  }

  // Creating accounts through /outbox is admin-only, so make sure the seeded
  // admin really is one (a member of the server's admin circle).
  const { Settings, Circle } = await import("#schema");
  const adminCircle = await Settings.findOne({ name: "adminCircle" }).lean();
  if (adminCircle?.value) {
    await Circle.updateOne(
      { id: adminCircle.value, "members.id": { $ne: "@admin@kwln.org" } },
      { $push: { members: { id: "@admin@kwln.org", name: "Admin" } } }
    );
  }

  return client;
}

export async function createUser(
  client,
  { username, password = "pw", name = username }
) {
  const { status, json } = await client.postOutbox({
    type: "Create",
    objectType: "User",
    object: { type: "User", username, password, profile: { name } },
    to: "@kwln.org",
  });
  if (status !== 200 && status !== 201)
    throw new Error("createUser failed " + status + " " + JSON.stringify(json));
  return json;
}

export async function createGroup(client, { name, summary }) {
  const { status, json } = await client.postOutbox({
    type: "Create",
    objectType: "Group",
    object: { type: "Group", name, summary },
    to: "@public",
  });
  if (status !== 200 && status !== 201)
    throw new Error(
      "createGroup failed " + status + " " + JSON.stringify(json)
    );
  return json; // should include group id in activity/object
}

/** Ensure membership via Activity (member → then optional role) */
// The member joins the group themselves -- the server always acts as the
// logged-in user, so an admin can't Join on someone else's behalf. Test
// groups are "open" by default, so the Join takes effect at once.
export async function joinGroup(memberClient, { groupId }) {
  const res = await memberClient.postOutbox({
    type: "Join",
    objectType: "Group",
    target: groupId,
  });
  if (res.status >= 300)
    throw new Error("joinGroup failed " + res.status + " " + JSON.stringify(res.json));
  return res.json;
}
