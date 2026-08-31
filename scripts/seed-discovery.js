// scripts/seed-discovery.js
// Seeds a few Discover shelves from existing public content on this server.
// Idempotent-ish: skips sections that already exist (by name) and won't
// re-add a ref that's already in the same section.
//
//   node scripts/seed-discovery.js

import "dotenv/config";
import Kowloon, { attachMethodDomains } from "#kowloon";
import initKowloon from "#methods/utils/init.js";
import {
  DiscoverySection,
  Discovery,
  Circle,
  Group,
  Post,
} from "#schema";

async function ensureSection({ name, summary, order }) {
  const existing = await DiscoverySection.findOne({ name, deletedAt: null });
  if (existing) {
    console.log(`  ~ section "${name}" exists (${existing.id})`);
    return existing;
  }
  const s = await DiscoverySection.create({
    name,
    summary,
    order,
    to: "@public",
  });
  console.log(`  + section "${name}" -> ${s.id}`);
  return s;
}

async function addItem(section, ref, note, order) {
  const dupe = await Discovery.findOne({
    section: section.id,
    ref,
    deletedAt: null,
  });
  if (dupe) return false;
  await Discovery.create({ section: section.id, ref, note, order });
  return true;
}

async function main() {
  console.log("-> Initializing Kowloon...");
  await initKowloon(Kowloon, {
    domain: process.env.DOMAIN,
    siteTitle: process.env.SITE_TITLE || "Kowloon",
    adminEmail: process.env.ADMIN_EMAIL,
  });
  await attachMethodDomains(Kowloon);

  // Pull top public content.
  const circles = await Circle.find({
    to: "@public",
    type: "Circle",
    deletedAt: null,
  })
    .sort({ reactCount: -1, memberCount: -1, createdAt: -1 })
    .limit(6)
    .lean();

  const groups = await Group.find({ to: "@public", deletedAt: null })
    .sort({ reactCount: -1, memberCount: -1, createdAt: -1 })
    .limit(6)
    .lean();

  // Prefer posts with an image for the visual shelf; fall back to any.
  let posts = await Post.find({
    to: "@public",
    deletedAt: null,
    image: { $ne: null },
  })
    .sort({ reactCount: -1, createdAt: -1 })
    .limit(6)
    .lean();
  if (posts.length === 0) {
    posts = await Post.find({ to: "@public", deletedAt: null })
      .sort({ reactCount: -1, createdAt: -1 })
      .limit(6)
      .lean();
  }

  console.log(
    `-> Found ${circles.length} circles, ${groups.length} groups, ${posts.length} posts`
  );

  let added = 0;

  if (circles.length) {
    const s = await ensureSection({
      name: "Circles to Explore",
      summary: "Curated lists of voices worth following.",
      order: 1,
    });
    let i = 0;
    for (const c of circles) if (await addItem(s, c.id, null, i++)) added++;
  }

  if (groups.length) {
    const s = await ensureSection({
      name: "Communities",
      summary: "Groups finding their footing on the server.",
      order: 2,
    });
    let i = 0;
    for (const g of groups) if (await addItem(s, g.id, null, i++)) added++;
  }

  if (posts.length) {
    const s = await ensureSection({
      name: "Posts We Love",
      summary: "A few things worth your attention.",
      order: 3,
    });
    let i = 0;
    for (const p of posts) if (await addItem(s, p.id, null, i++)) added++;
  }

  console.log(`\nDone. Added ${added} discovery items.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
