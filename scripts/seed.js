// scripts/seed.js
import "dotenv/config";
import { faker } from "@faker-js/faker";
import Kowloon, { attachMethodDomains } from "#kowloon";
import initKowloon from "#methods/utils/init.js";
import * as Models from "#schema/index.js";
import { getSetting } from "#methods/settings/cache.js";

// ── Server pages seeded on every run (upsert by slug) ──────────────────────
const SERVER_PAGE_DEFS = [
  {
    slug: "about",
    title: "About This Server",
    summary: "Who we are, what we do, and why we do it.",
    order: 1,
    source: {
      mediaType: "text/markdown",
      content: `# About This Server\n\nKowloon is a small, intentional community for people who care about design, music, writing, and the pleasures of a well-made thing. We run on open-source federated software.\n\n## What We Are\n\nA place to think out loud, share work, and find people who are interested in the same things you are. We are not trying to be large. We are trying to be good.\n\n## What We Believe\n\nThat the internet was better when it was made of individual, idiosyncratic places. That you should own your words. That slow is fine.`,
    },
  },
  {
    slug: "projects",
    type: "Folder",
    title: "Projects",
    summary: "Ongoing and completed projects by server members.",
    order: 2,
    source: { mediaType: "text/markdown", content: "# Projects\n\nA collection of things we are building, writing, and making." },
  },
  {
    slug: "contact",
    title: "Contact",
    summary: "How to reach the server administrators.",
    order: 3,
    source: { mediaType: "text/markdown", content: "# Contact\n\nSend a message to **@admin** on this server, or use the email address in our federation profile." },
  },
  {
    slug: "rules",
    title: "Rules & Guidelines",
    summary: "A short list of expectations for members of this community.",
    parentSlug: "about",
    order: 1,
    source: {
      mediaType: "text/markdown",
      content: `# Rules & Guidelines\n\n## Be decent\n\nTreat people the way you would want to be treated in a small community.\n\n## No harassment\n\nDo not target, threaten, or repeatedly contact someone who does not want to hear from you.\n\n## No spam\n\nPost because you have something to say, not to fill a feed.\n\n## Follow the law\n\nDo not post content that is illegal in your jurisdiction or ours.`,
    },
  },
  {
    slug: "privacy",
    title: "Privacy Policy",
    summary: "How we handle your data and what we share with others.",
    parentSlug: "about",
    order: 2,
    source: {
      mediaType: "text/markdown",
      content: `# Privacy Policy\n\n## What we collect\n\nYour username, email (hashed password), posts, and profile information you provide voluntarily.\n\n## What we share\n\nContent marked **public** is federated and accessible to anyone. Content marked **server-only** stays here.\n\nWe do not sell your data or run advertising.\n\n## Data retention\n\nYour data is retained as long as your account exists. Contact an admin to request deletion.`,
    },
  },
];

// -------- CLI args (no extra deps) --------
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v === undefined ? true : isNaN(+v) ? v : +v];
  })
);

const RUN_ID = (args.runId && String(args.runId)) || `seed_${Date.now()}`;

// Defaults (override via flags)
const COUNTS = {
  users: args.users ?? 20,
  groups: args.groups ?? 6,
  circles: args.circles ?? 8,
  pageFolders: args.pageFolders ?? 6,
  pages: args.pages ?? 30,
  bookmarkFolders: args.bookmarkFolders ?? 6,
  bookmarks: args.bookmarks ?? 40,
  posts: args.posts ?? 100,
  replies: args.replies ?? 150,
  reacts: args.reacts ?? 200,
};

// ----------------- helpers -----------------
const randEl = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randSubset = (arr, max = arr.length) => {
  const n = Math.floor(Math.random() * (Math.min(arr.length, max) + 1));
  const copy = arr.slice();
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }
  return out;
};

const shortText = (max = 200) => {
  let s = faker.lorem.sentences({ min: 1, max: 3 });
  if (s.length > max) s = s.slice(0, max - 3) + "...";
  return s;
};

const noteBody = () => {
  let s = faker.lorem.paragraphs({ min: 1, max: 2 });
  if (s.length > 480) s = s.slice(0, 480);
  return s;
};

const makeGeoPoint = (name = faker.location.city()) => {
  const lat = Number(faker.location.latitude());
  const lng = Number(faker.location.longitude());
  return { name, type: "Point", coordinates: [lng, lat] }; // [lng, lat]
};

const toMember = (u, fallbackServer) => ({
  id: u.id, // required by Member
  name: u.profile?.name,
  inbox: u.inbox,
  outbox: u.outbox,
  icon: u.profile?.avatar,
  url: u.url,
  server: u.server || fallbackServer,
});

// Single-recipient addressing: one of "@public", "@<server>", or one Circle/Group ID
function pickSingleAddress({ domain, circles = [], groups = [] }) {
  const r = Math.random();
  if (r < 0.7) return "@public"; // 70% public
  if (r < 0.85) return `@${domain}`; // 15% server-addressed
  const pools = [
    ...circles.map((c) => c.id),
    ...groups.map((g) => g.id),
  ];
  return pools.length ? randEl(pools) : "@public"; // 15% scoped
}

function addressingTriple({ domain, circles, groups }) {
  const to = pickSingleAddress({ domain, circles, groups });
  const canReply =
    Math.random() < 0.9
      ? to
      : pickSingleAddress({ domain, circles, groups });
  const canReact =
    Math.random() < 0.9
      ? to
      : pickSingleAddress({ domain, circles, groups });
  return { to, canReply, canReact };
}

// -------------- main seeding --------------
async function main() {
  console.log("→ Initializing Kowloon (DB + settings)...");
  await initKowloon(Kowloon, {
    domain: process.env.DOMAIN,
    siteTitle: process.env.SITE_TITLE || "Kowloon",
    adminEmail: process.env.ADMIN_EMAIL,
    smtpHost: process.env.SMTP_HOST,
    smtpUser: process.env.SMTP_USER,
    smtpPass: process.env.SMTP_PASS,
  });

  // Ensure methods are attached after DB is ready
  await attachMethodDomains(Kowloon);

  const {
    Settings,
    User,
    Post,
    Reply,
    React,
    Page,
    Bookmark,
    Group,
    Circle,
  } = Models;

  // Optionally wipe previous run
  if (args.wipe && args.runId) {
    console.log(`→ Wiping docs with meta.runId="${args.runId}"...`);
    await Promise.all([
      User.deleteMany({ "meta.runId": args.runId }),
      Group.deleteMany({ "meta.runId": args.runId }),
      Circle.deleteMany({ "meta.runId": args.runId }),
      Page.deleteMany({ "meta.runId": args.runId }),
      Bookmark.deleteMany({ "meta.runId": args.runId }),
      Post.deleteMany({ "meta.runId": args.runId }),
      Reply.deleteMany({ "meta.runId": args.runId }),
      React.deleteMany({ "meta.runId": args.runId }),
    ]);
  }

  // Pull settings we need (domain, reactEmojis, etc.)
  const settingsDocs = await Settings.find().lean();
  const settings = Object.fromEntries(
    settingsDocs.map((s) => [s.name, s.value])
  );
  const domain = (
    settings.domain ||
    process.env.DOMAIN ||
    "example.org"
  ).toLowerCase();

  // Ensure reactEmojis exists
  let reactEmojis = settings.reactEmojis;
  if (!Array.isArray(reactEmojis) || reactEmojis.length === 0) {
    reactEmojis = [
      { name: "like", emoji: "👍" },
      { name: "love", emoji: "❤️" },
      { name: "laugh", emoji: "😂" },
      { name: "wow", emoji: "😮" },
      { name: "sad", emoji: "😢" },
    ];
    await Settings.findOneAndUpdate(
      { name: "reactEmojis" },
      { value: reactEmojis },
      { upsert: true }
    );
    console.log("→ Seeded default reactEmojis in Settings");
  }

  // Declare containers up-front (avoid TDZ)
  const users = [];
  const groups = [];
  const circles = [];
  const pageFolders = [];
  const pages = [];
  const bookmarkFolders = [];
  const bookmarks = [];
  const posts = [];
  const replies = [];
  const reacts = [];

  // ========== 1) USERS ==========
  console.log(`→ Creating ${COUNTS.users} users... (password: 12345)`);
  for (let i = 0; i < COUNTS.users; i++) {
    const username =
      faker.internet
        .username()
        .replace(/[^a-zA-Z0-9_.-]/g, "")
        .slice(0, 20) || `user${Date.now()}${i}`;
    const email = faker.internet.email({ firstName: username }).toLowerCase();

    const profile = {
      name: faker.person.fullName(),
      bio: shortText(160),
      location: makeGeoPoint(), // GeoPoint
      url: faker.internet.url(),
      avatar: faker.image.avatar(),
      banner: faker.image.urlPicsumPhotos({ width: 1200, height: 300 }),
    };

    const userTo = Math.random() < 0.9 ? "@public" : `@${domain}`; // mostly public
    const userReplyTo = userTo; // keep simple for users
    const userReactTo = userTo;

    const userDoc = await User.create({
      username,
      email,
      password: "12345", // schema will hash
      profile,
      to: userTo,
      canReply: userTo,
      canReact: userTo,
      meta: { runId: RUN_ID },
      // id/url generated by pre-save
    });
    users.push(userDoc);
  }
  const userIds = users.map((u) => u.id);

  // ========== 2) GROUPS ==========
  console.log(`→ Creating ${COUNTS.groups} Groups...`);
  for (let i = 0; i < COUNTS.groups; i++) {
    const creator = randEl(users);
    const g = await Group.create({
      actorId: creator.id,
      name: faker.commerce.department(),
      description: shortText(280),
      meta: { runId: RUN_ID },
    });
    groups.push(g);
  }

  // ========== 3) CIRCLES ==========
  console.log(`→ Creating ${COUNTS.circles} Circles...`);
  for (let i = 0; i < COUNTS.circles; i++) {
    const owner = randEl(users);
    const cAddr = addressingTriple({ domain, circles: [], groups });

    const pool = users.filter((u) => u.id !== owner.id);
    const picked = randSubset(pool, Math.min(12, pool.length));
    const members = picked.map((u) => toMember(u, domain)); // embedded Member docs

    const c = await Circle.create({
      actorId: owner.id,
      name: faker.word
        .words({ count: { min: 1, max: 3 } })
        .split(" ")
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join(" "),
      summary: shortText(160),
      to: cAddr.to,
      canReply: cAddr.canReply,
      canReact: cAddr.canReact,
      members,
      meta: { runId: RUN_ID },
    });
    circles.push(c);
  }

  // ========== 4) SERVER PAGES (upsert) ==========
  console.log("→ Upserting server pages...");
  {
    const serverActorId =
      getSetting("actorId") || `https://${domain}/server`;
    const slugToId = {};
    const topFirst = [
      ...SERVER_PAGE_DEFS.filter((p) => !p.parentSlug),
      ...SERVER_PAGE_DEFS.filter((p) => p.parentSlug),
    ];
    for (const def of topFirst) {
      const { parentSlug, type, slug, title, summary, order, source } = def;
      const parentFolder = parentSlug ? slugToId[parentSlug] : undefined;
      const existing = await Page.findOne({ slug, deletedAt: null }).lean();
      if (existing) {
        slugToId[slug] = existing.id;
        continue;
      }
      const p = await Page.create({
        type: type ?? "Page",
        actorId: serverActorId,
        title, slug, summary, order, source,
        parentId: parentFolder,
        to: "@public", canReply: "@public", canReact: "@public",
      });
      slugToId[slug] = p.id;
      pages.push(p);
    }
  }

  // ========== 5) PAGE FOLDERS (random) ==========
  console.log(`→ Creating ${COUNTS.pageFolders} Page folders...`);
  for (let i = 0; i < COUNTS.pageFolders; i++) {
    const owner = randEl(users);
    const folder = await Page.create({
      type: "Folder",
      actorId: owner.id,
      title: faker.commerce.department() + " Docs",
      description: shortText(200),
      meta: { runId: RUN_ID },
    });
    pageFolders.push(folder);
  }

  // ========== 6) PAGES (random) ==========
  console.log(`→ Creating ${COUNTS.pages} Pages...`);
  for (let i = 0; i < COUNTS.pages; i++) {
    const owner = randEl(users);
    const parent = pageFolders.length ? randEl(pageFolders) : null;
    const title = faker.lorem.words({ min: 2, max: 6 });
    const md = `# ${title}\n\n${faker.lorem.paragraphs({ min: 1, max: 3 })}`;
    const { to, canReply, canReact } = addressingTriple({
      domain,
      circles,
      groups,
    });

    const p = await Page.create({
      type: "Page",
      actorId: owner.id,
      title,
      parentId: parent ? parent.id : undefined,
      source: { mediaType: "text/markdown", content: md },
      summary: shortText(240),
      to,
      canReply,
      canReact,
      meta: { runId: RUN_ID },
    });
    pages.push(p);
  }

  // ========== 6) BOOKMARK FOLDERS ==========
  console.log(`→ Creating ${COUNTS.bookmarkFolders} Bookmark folders...`);
  for (let i = 0; i < COUNTS.bookmarkFolders; i++) {
    const owner = randEl(users);
    const folder = await Bookmark.create({
      type: "Folder",
      ownerId: owner.id,
      ownerType: "User",
      title: faker.commerce.department() + " Links",
      description: shortText(180),
      meta: { runId: RUN_ID },
    });
    bookmarkFolders.push(folder);
  }

  // ========== 7) BOOKMARKS ==========
  console.log(`→ Creating ${COUNTS.bookmarks} Bookmarks...`);
  for (let i = 0; i < COUNTS.bookmarks; i++) {
    const owner = randEl(users);
    const parent = bookmarkFolders.length ? randEl(bookmarkFolders) : null;

    const useExternal = Math.random() < 0.6 || pages.length === 0; // bias to external
    const base = {
      type: "Bookmark",
      ownerId: owner.id,
      ownerType: "User",
      parentFolder: parent ? parent.id : undefined,
      title: faker.lorem.words({ min: 2, max: 6 }),
      description: shortText(200),
      tags: randSubset(
        ["work", "personal", "reference", "tutorial", "news", "dev"],
        3
      ),
      meta: { runId: RUN_ID },
    };

    if (useExternal) {
      base.href = faker.internet.url();
    } else {
      const targetPage = randEl(pages);
      base.target = targetPage.id; // internal id like page:<_id>@domain
    }

    const b = await Bookmark.create(base);
    bookmarks.push(b);
  }

  // ========== 8) POSTS ==========
  console.log(
    `→ Creating ${COUNTS.posts} Posts (Note/Article/Link; no Media)...`
  );
  const postTypes = ["Note", "Article", "Link"];
  for (let i = 0; i < COUNTS.posts; i++) {
    const author = randEl(users);
    const t = randEl(postTypes);
    const { to, canReply, canReact } = addressingTriple({
      domain,
      circles,
      groups,
    });

    const base = {
      actorId: author.id,
      type: t,
      to,
      canReply,
      canReact,
      meta: { runId: RUN_ID },
    };

    if (t === "Note") {
      base.source = { mediaType: "text/markdown", content: noteBody() };
      base.summary = Math.random() < 0.3 ? shortText(160) : undefined;
    } else if (t === "Article") {
      const title = faker.lorem.words({ min: 3, max: 8 });
      const md = `# ${title}\n\n${faker.lorem.paragraphs({ min: 2, max: 5 })}`;
      base.title = title;
      base.source = { mediaType: "text/markdown", content: md };
      base.summary = shortText(220);
    } else if (t === "Link") {
      base.title = faker.lorem.words({ min: 2, max: 6 });
      base.href = faker.internet.url();
      base.summary = shortText(180);
      base.source = { mediaType: "text/markdown", content: shortText(240) };
    }

    const p = await Post.create(base);
    posts.push(p);
  }

  // ========== 9) REPLIES ==========
  console.log(`→ Creating ${COUNTS.replies} Replies...`);
  const replyTargets = [...posts, ...pages];
  for (let i = 0; i < COUNTS.replies; i++) {
    if (replyTargets.length === 0) break;

    const replier = randEl(users);
    const target = randEl(replyTargets);
    const targetActorId = target.actorId || randEl(users).id;

    const r = await Reply.create({
      actorId: replier.id,
      target: target.id,
      targetActorId,
      source: { mediaType: "text/markdown", content: shortText(240) },
      meta: { runId: RUN_ID },
    });
    replies.push(r);
  }

  // ========== 10) REACTS ==========
  console.log(
    `→ Creating ${COUNTS.reacts} Reacts (using Settings.reactEmojis)...`
  );
  const reactables = [...posts, ...replies, ...pages];
  for (let i = 0; i < COUNTS.reacts; i++) {
    if (reactables.length === 0) break;

    const reactor = randEl(users);
    const target = randEl(reactables);
    const choice = randEl(reactEmojis); // { name, emoji }

    // React has a unique {actorId, target} index (one reaction per user per
    // target); random picks can repeat a pair, so skip those instead of dying.
    let rx;
    try {
      rx = await React.create({
        actorId: reactor.id,
        target: target.id,
        name: choice.name,
        emoji: choice.emoji,
        meta: { runId: RUN_ID },
      });
    } catch (err) {
      if (err?.code === 11000) continue;
      throw err;
    }
    reacts.push(rx);
  }

  // -------- summary --------
  console.log("\n✅ Seed complete.");
  console.table({
    runId: RUN_ID,
    Users: users.length,
    Groups: groups.length,
    Circles: circles.length,
    "Page Folders": pageFolders.length,
    Pages: pages.length,
    "Bookmark Folders": bookmarkFolders.length,
    Bookmarks: bookmarks.length,
    Posts: posts.length,
    Replies: replies.length,
    Reacts: reacts.length,
  });

  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
