#!/usr/bin/env node
// Seed the five canonical Discover rows (one per content type). Idempotent:
// creates a section for any type that doesn't have one yet; leaves existing
// sections (and any admin edits to them) untouched.
//
// Usage: node scripts/seed-discover-sections.js

import "dotenv/config";
import mongoose from "mongoose";
import { DiscoverySection, Settings } from "#schema";
import { loadSettings } from "#methods/settings/cache.js";

const CANONICAL = [
  { contentType: "media", name: "Media", order: 0, targetCount: 12 },
  { contentType: "posts", name: "Posts", order: 1, targetCount: 8 },
  { contentType: "circles", name: "Circles", order: 2, targetCount: 8 },
  { contentType: "groups", name: "Groups", order: 3, targetCount: 8 },
  { contentType: "servers", name: "Servers", order: 4, targetCount: 8 },
];

async function main() {
  const mongoUrl =
    process.env.MONGO_URI || process.env.MONGO_URL || "mongodb://localhost:27017/kowloon";
  await mongoose.connect(mongoUrl);
  await loadSettings(Settings);

  let created = 0, skipped = 0;
  for (const c of CANONICAL) {
    const existing = await DiscoverySection.findOne({
      contentType: c.contentType,
      deletedAt: null,
    }).lean();
    if (existing) {
      skipped++;
      console.log(`  skip: ${c.contentType} (exists: ${existing.id})`);
      continue;
    }
    const section = new DiscoverySection({
      name: c.name,
      contentType: c.contentType,
      source: "hybrid",
      targetCount: c.targetCount,
      order: c.order,
      active: true,
      to: "@public",
    });
    await section.save(); // pre-save sets id/slug/signature/actorId
    created++;
    console.log(`  created: ${c.contentType} -> ${section.id}`);
  }

  console.log(`\nDone: ${created} created, ${skipped} skipped.`);
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
