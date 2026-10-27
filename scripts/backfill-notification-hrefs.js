#!/usr/bin/env node
// Backfill notification.href values stuck with a literal "undefined://" scheme
// — caused by generateHref() destructuring a nonexistent `protocol` key off
// getServerSettings() (fixed in methods/notifications/create.js). Every
// notification created before that fix has this baked in permanently.
//
// Usage:
//   node scripts/backfill-notification-hrefs.js            # dry run (counts only)
//   node scripts/backfill-notification-hrefs.js --write     # apply

import "dotenv/config";
import mongoose from "mongoose";
import { Notification, Settings } from "#schema";
import { loadSettings } from "#methods/settings/cache.js";
import { getServerSettings } from "#methods/settings/schemaHelpers.js";

const DRY_RUN = !process.argv.includes("--write");
const BROKEN_RE = /^undefined:\/\//;

async function main() {
  const mongoUrl =
    process.env.MONGO_URI || process.env.MONGO_URL || "mongodb://localhost:27017/kowloon";
  await mongoose.connect(mongoUrl);
  await loadSettings(Settings);
  console.log(`Connected: ${mongoUrl}`);
  console.log(DRY_RUN ? "DRY RUN — pass --write to apply" : "WRITE MODE");

  const { domain } = getServerSettings();
  const protocol = domain === "localhost" ? "http" : "https";

  const broken = await Notification.find({ href: { $regex: BROKEN_RE } }).select("_id href");
  console.log(`Found ${broken.length} notification(s) with a broken "undefined://" href`);

  if (DRY_RUN) {
    for (const n of broken.slice(0, 10)) console.log(`  ${n._id}: ${n.href}`);
    if (broken.length > 10) console.log(`  ...and ${broken.length - 10} more`);
    return;
  }

  let fixed = 0;
  for (const n of broken) {
    const newHref = n.href.replace(BROKEN_RE, `${protocol}://`);
    await Notification.updateOne({ _id: n._id }, { $set: { href: newHref } });
    fixed++;
  }
  console.log(`Fixed ${fixed} notification(s)`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
