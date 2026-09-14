// scripts/seed-test.js
// Deterministic seed script — creates all test data via the Kowloon API.
// Using the API ensures ActivityParser runs, creating FeedItems, FeedFanOuts,
// notifications, etc. exactly as production does.
//
// Requires: server running at TEST_BASE_URL (default http://localhost:3000)
//
// Usage:
//   node scripts/seed-test.js              # seed only
//   node scripts/seed-test.js --wipe       # wipe first, then seed
//   node scripts/seed-test.js --wipe-only  # wipe only

import "dotenv/config";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3000";
const DOMAIN = process.env.DOMAIN || "kwln.org";
const PASSWORD = "testpass";
// The first-boot admin account (see setup/ + ADMIN_USERNAME/ADMIN_PASSWORD in
// .env), needed to mint an invite now that registration always requires one.
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";

const args = new Set(process.argv.slice(2));

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function request(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(
      `${method} ${path} → ${res.status}: ${data.error || JSON.stringify(data)}`
    );
  }
  return data;
}

const POST = (path, body, token) => request("POST", path, body, token);

async function login(username, password = PASSWORD) {
  // NOTE: was POSTing to "/auth", never a real route — fixed while touching
  // this function to add the admin bootstrap login below. This script was
  // broken regardless of the invite-required change.
  const r = await POST("/auth/login", { username, password });
  return { token: r.token, user: r.user };
}

async function register(data) {
  return POST("/register", data);
}

// Registration always requires an invite code — mint one unlimited-use "open"
// invite via the first-boot admin account and reuse it for every seeded user,
// rather than threading a real invite through each individually. Matches how
// an admin actually onboards a batch of people in production.
async function createSeedInvite() {
  const { token } = await login(ADMIN_USERNAME, ADMIN_PASSWORD);
  const { invite } = await POST(
    "/admin/invites",
    { type: "open", note: "seed-test.js" },
    token
  );
  return invite.code;
}

// POST an activity to /outbox and return the response
async function activity(token, act) {
  return POST("/outbox", act, token);
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  // ── Wipe ──────────────────────────────────────────────────────────────────

  if (args.has("--wipe") || args.has("--wipe-only")) {
    throw new Error(
      "--wipe/--wipe-only relied on POST /__test/wipe, which has been removed " +
      "(issue #51 -- unauthenticated DB-wipe endpoint). Wipe the target database " +
      "directly instead, e.g. `mongosh <MONGO_URI> --eval 'db.dropDatabase()'`."
    );
  }

  // ── Step 1: Register users ────────────────────────────────────────────────

  console.log("→ Minting a seed invite via the admin account...");
  const inviteCode = await createSeedInvite();

  console.log("→ Registering 4 users (password: testpass)...");

  await register({
    username: "alice",
    email: "alice@example.com",
    password: PASSWORD,
    inviteCode,
    profile: { name: "Alice Anderson", bio: "Public user for testing" },
    to: "@public",
    canReply: "@public",
    canReact: "@public",
  });

  await register({
    username: "bob",
    email: "bob@example.com",
    password: PASSWORD,
    inviteCode,
    profile: { name: "Bob Baker", bio: "Server-only user for testing" },
    to: `@${DOMAIN}`,
    canReply: `@${DOMAIN}`,
    canReact: `@${DOMAIN}`,
  });

  // Carol starts @public; updated to circle-scoped after circles are created
  await register({
    username: "carol",
    email: "carol@example.com",
    password: PASSWORD,
    inviteCode,
    profile: { name: "Carol Chen", bio: "Circle-only user for testing" },
    to: "@public",
    canReply: "@public",
    canReact: "@public",
  });

  // Dave is private (only visible to himself)
  await register({
    username: "dave",
    email: "dave@example.com",
    password: PASSWORD,
    inviteCode,
    profile: { name: "Dave Davis", bio: "Private user for testing" },
    to: `@dave@${DOMAIN}`,
    canReply: `@dave@${DOMAIN}`,
    canReact: `@dave@${DOMAIN}`,
  });

  // ── Step 2: Login ─────────────────────────────────────────────────────────

  const [aliceAuth, bobAuth, carolAuth, daveAuth] = await Promise.all([
    login("alice"),
    login("bob"),
    login("carol"),
    login("dave"),
  ]);

  const T = {
    alice: aliceAuth.token,
    bob: bobAuth.token,
    carol: carolAuth.token,
    dave: daveAuth.token,
  };

  const U = {
    alice: aliceAuth.user,
    bob: bobAuth.user,
    carol: carolAuth.user,
    dave: daveAuth.user,
  };

  console.log(`  Users: ${Object.keys(U).map((n) => `${n} (${U[n].id})`).join(", ")}`);

  // ── Step 3: Create circles (4 per user = 16) ──────────────────────────────
  // public, server, inner (visible to Following circle members), private

  console.log("→ Creating 4 circles per user (16 total)...");

  const C = {}; // C.alice.public, C.alice.server, C.alice.inner, C.alice.private

  for (const name of ["alice", "bob", "carol", "dave"]) {
    const token = T[name];
    const user = U[name];
    // user.following is the system Following circle ID (from JWT payload)
    const followingCircleId = user.following;

    const [pub, srv, inner, prv] = await Promise.all([
      activity(token, {
        type: "Create", objectType: "Circle", to: "@public",
        object: { type: "Circle", name: `${name}'s Public List`, to: "@public" },
      }),
      activity(token, {
        type: "Create", objectType: "Circle", to: `@${DOMAIN}`,
        object: { type: "Circle", name: `${name}'s Server List`, to: `@${DOMAIN}` },
      }),
      activity(token, {
        type: "Create", objectType: "Circle", to: followingCircleId,
        object: { type: "Circle", name: `${name}'s Inner Circle`, to: followingCircleId },
      }),
      activity(token, {
        type: "Create", objectType: "Circle", to: user.id,
        object: { type: "Circle", name: `${name}'s Private List`, to: user.id },
      }),
    ]);

    C[name] = {
      public: pub.result,
      server: srv.result,
      inner: inner.result,
      private: prv.result,
    };
  }

  console.log("  Created 16 user circles.");

  // ── Step 4: Update Carol's profile to circle-scoped ───────────────────────

  const carolInnerCircleId = C.carol.inner.id;
  await activity(T.carol, {
    type: "Update",
    objectType: "User",
    target: U.carol.id,
    object: {
      to: carolInnerCircleId,
      canReply: carolInnerCircleId,
      canReact: carolInnerCircleId,
    },
  });
  console.log(`  Carol's profile updated to circle-scoped (${carolInnerCircleId}).`);

  // ── Step 5: Wire following (full mesh via Add — Circles are the only
  //           follow mechanism, following = adding to your own Following
  //           circle) ────────────────────────────────────────────────────

  console.log("→ Wiring cross-follows...");

  const names = ["alice", "bob", "carol", "dave"];
  await Promise.all(
    names.flatMap((follower) =>
      names
        .filter((n) => n !== follower)
        .map((followed) =>
          activity(T[follower], {
            type: "Add",
            object: U[followed].id,
            target: U[follower].following,
          })
        )
    )
  );

  console.log("  Full-mesh follows wired.");

  // ── Step 6: Populate custom circles ───────────────────────────────────────

  console.log("→ Adding members to custom circles...");

  // Alice's public circle: bob, carol
  await Promise.all([
    activity(T.alice, { type: "Add", object: U.bob.id,   target: C.alice.public.id }),
    activity(T.alice, { type: "Add", object: U.carol.id, target: C.alice.public.id }),
  ]);

  // Bob's server circle: alice, dave
  await Promise.all([
    activity(T.bob, { type: "Add", object: U.alice.id, target: C.bob.server.id }),
    activity(T.bob, { type: "Add", object: U.dave.id,  target: C.bob.server.id }),
  ]);

  // Carol's inner circle: alice
  await activity(T.carol, { type: "Add", object: U.alice.id, target: C.carol.inner.id });

  // Dave's private circle: bob
  await activity(T.dave, { type: "Add", object: U.bob.id, target: C.dave.private.id });

  console.log("  Circle memberships wired.");

  // ── Step 7: Create groups (3 per alice & bob = 6) ─────────────────────────

  console.log("→ Creating 6 groups (3 per alice & bob)...");

  const G = {}; // G.alice.public, G.alice.server, G.alice.circle, etc.

  for (const name of ["alice", "bob"]) {
    const token = T[name];

    const [pub, srv, cir] = await Promise.all([
      activity(token, {
        type: "Create", objectType: "Group", to: "@public",
        object: { type: "Group", name: `${name}'s Public Group`, summary: `Open group by ${name}`, rsvpPolicy: "open" },
      }),
      activity(token, {
        type: "Create", objectType: "Group", to: `@${DOMAIN}`,
        object: { type: "Group", name: `${name}'s Server Group`, summary: `Server-only group by ${name}`, rsvpPolicy: "serverOpen" },
      }),
      activity(token, {
        type: "Create", objectType: "Group", to: C[name].public.id,
        object: { type: "Group", name: `${name}'s Circle Group`, summary: `Circle-scoped group by ${name}`, rsvpPolicy: "approvalOnly" },
      }),
    ]);

    G[name] = { public: pub.result, server: srv.result, circle: cir.result };
  }

  console.log("  Created 6 groups.");

  // ── Step 8: Add members to groups ─────────────────────────────────────────

  console.log("→ Adding members to groups...");

  for (const creator of ["alice", "bob"]) {
    const others = names.filter((n) => n !== creator);

    // Public group: add all others
    await Promise.all(
      others.map((n) =>
        activity(T[creator], { type: "Add", object: U[n].id, to: G[creator].public.id })
      )
    );

    // Server group: add first two others
    await Promise.all(
      others.slice(0, 2).map((n) =>
        activity(T[creator], { type: "Add", object: U[n].id, to: G[creator].server.id })
      )
    );

    // Circle group: add first other only
    await activity(T[creator], {
      type: "Add", object: U[others[0]].id, to: G[creator].circle.id,
    });
  }

  console.log("  Group memberships wired.");

  // ── Step 9: Create posts (4 per user = 16) ────────────────────────────────

  console.log("→ Creating 16 posts (4 per user)...");

  const posts = {}; // posts.alice.public, posts.alice.server, etc.

  for (const name of names) {
    const token = T[name];
    const user = U[name];
    const userCircles = C[name];

    const visibilities = [
      { label: "public",  to: "@public",             canReply: "@public",             canReact: "@public" },
      { label: "server",  to: `@${DOMAIN}`,           canReply: `@${DOMAIN}`,           canReact: "@public" },
      { label: "circle",  to: userCircles.public.id,  canReply: userCircles.public.id,  canReact: `@${DOMAIN}` },
      { label: "private", to: userCircles.private.id,  canReply: userCircles.private.id,  canReact: userCircles.private.id },
    ];

    posts[name] = {};
    for (const vis of visibilities) {
      const r = await activity(token, {
        type: "Create",
        objectType: "Post",
        to: vis.to,
        canReply: vis.canReply,
        canReact: vis.canReact,
        object: {
          type: "Note",
          content: `This is ${name}'s ${vis.label} post. Visible to: ${vis.to}`,
          tags: ["test", vis.label],
        },
      });
      posts[name][vis.label] = r.result;
    }
  }

  console.log("  Created 16 posts.");

  // ── Step 10: Create replies ───────────────────────────────────────────────

  console.log("→ Creating replies...");

  // Bob replies to Alice's public post
  await activity(T.bob, {
    type: "Reply", objectType: "Reply",
    to: posts.alice.public.id,
    object: { type: "Reply", content: "Nice public post, Alice!" },
  });

  // Carol replies to Alice's public post (thread)
  await activity(T.carol, {
    type: "Reply", objectType: "Reply",
    to: posts.alice.public.id,
    object: { type: "Reply", content: "I agree with Bob!" },
  });

  // Carol replies to Bob's server post
  await activity(T.carol, {
    type: "Reply", objectType: "Reply",
    to: posts.bob.server.id,
    object: { type: "Reply", content: "Server-only reply from Carol." },
  });

  console.log("  Created 3 replies.");

  // ── Step 11: Create reacts ────────────────────────────────────────────────

  console.log("→ Creating reacts...");

  const emojis = [
    { name: "like",  react: "\u{1F44D}" },
    { name: "love",  react: "\u{2764}\u{FE0F}" },
    { name: "laugh", react: "\u{1F602}" },
    { name: "like",  react: "\u{1F44D}" },
  ];

  // Each user reacts to the next user's public post (rotating)
  await Promise.all(
    names.map((name, i) => {
      const reactor = names[(i + 1) % names.length];
      const emoji = emojis[i];
      return activity(T[reactor], {
        type: "React", objectType: "React",
        to: posts[name].public.id,
        object: { type: "React", react: emoji.react, name: emoji.name },
      });
    })
  );

  console.log("  Created 4 reacts.");

  // ── Step 12: Create bookmarks ─────────────────────────────────────────────

  console.log("→ Creating bookmarks...");

  // One folder for alice
  const folderRes = await activity(T.alice, {
    type: "Create", objectType: "Bookmark", to: "@public",
    object: { type: "Folder", title: "Alice's Test Folder" },
  });
  const folder = folderRes.result;
  let bookmarkCount = 1;

  for (const name of names) {
    const token = T[name];
    const user = U[name];
    const userCircles = C[name];

    const visibilities = [
      { label: "public",  to: "@public" },
      { label: "server",  to: `@${DOMAIN}` },
      { label: "circle",  to: userCircles.public.id },
      { label: "private", to: user.id },
    ];

    for (const vis of visibilities) {
      await activity(token, {
        type: "Create", objectType: "Bookmark", to: vis.to,
        object: {
          type: "Bookmark",
          title: `${name}'s ${vis.label} bookmark`,
          href: `https://example.com/${name}/${vis.label}`,
          description: `A ${vis.label} bookmark by ${name}`,
          tags: ["test", vis.label],
          ...(name === "alice" && vis.label === "public" ? { parentFolder: folder.id } : {}),
        },
      });
      bookmarkCount++;
    }
  }

  console.log(`  Created ${bookmarkCount} bookmarks (including 1 folder).`);

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log("\n=== Seed Complete ===");
  console.table({
    "Base URL": BASE_URL,
    Users: 4,
    "User Circles": 16,
    "System Circles": "auto (5 per user)",
    Groups: 6,
    Posts: 16,
    Replies: 3,
    Reacts: 4,
    Bookmarks: bookmarkCount,
  });

  console.log("\n--- Users ---");
  for (const name of names) {
    console.log(`  ${name}: id=${U[name].id}`);
  }

  console.log("\n--- User Circles ---");
  for (const name of names) {
    for (const [vis, c] of Object.entries(C[name])) {
      console.log(`  ${name}/${vis}: id=${c.id}, to=${c.to}`);
    }
  }

  console.log("\n--- Groups ---");
  for (const creator of ["alice", "bob"]) {
    for (const [vis, g] of Object.entries(G[creator])) {
      console.log(`  ${creator}/${vis}: id=${g.id}, to=${g.to}`);
    }
  }

  console.log("\nAll passwords: testpass");
}

main().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
