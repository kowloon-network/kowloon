// GET /groups/:id/members follows the group's own visibility (its `to`):
// a public group's member list is visible to anyone who can see the group,
// and it reflects joins as they happen.
import { TestClient } from "../helpers/client.js";
import { seedAdminAndLogin, createUser, createGroup, joinGroup } from "../helpers/seedApi.js";

let admin;

beforeAll(async () => {
  admin = await seedAdminAndLogin();
});

test("a public group's member list shows who has joined", async () => {
  await createUser(admin, { username: "alice", password: "pw", name: "Alice" });
  await createUser(admin, { username: "bob", password: "pw", name: "Bob" });

  const groupCreate = await createGroup(admin, { name: "Test Group", summary: "hello" });
  const groupId = groupCreate?.result?.id || groupCreate?.activity?.objectId;
  expect(groupId).toMatch(/^group:/);

  const alice = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
  await alice.login("alice", "pw");
  const bob = new TestClient({ baseURL: global.__TEST_BASE_URL__ });
  await bob.login("bob", "pw");

  const roster = async (client) => {
    const { status, json } = await client.request(`/groups/${encodeURIComponent(groupId)}/members`);
    expect(status).toBe(200);
    return (json.members || []).map((m) => m.id);
  };

  expect(await roster(bob)).not.toContain("@alice@kwln.org");

  await joinGroup(alice, { groupId });

  // Alice sees herself, and so does Bob, who isn't a member.
  expect(await roster(alice)).toContain("@alice@kwln.org");
  expect(await roster(bob)).toContain("@alice@kwln.org");
  expect(await roster(bob)).not.toContain("@bob@kwln.org");
});
