#!/usr/bin/env node
/**
 * seed-legal-pages.js -- publish/refresh the Terms of Service, Privacy Policy
 * and Community Rules pages for THIS server.
 *
 * New servers get these automatically at startup (methods/pages/legalPages.js).
 * Use this script to rewrite them from the templates, e.g. after editing the
 * community rules in admin.
 *
 *   node scripts/seed-legal-pages.js            # create if missing
 *   node scripts/seed-legal-pages.js --force    # overwrite existing bodies
 */
import mongoose from "mongoose";
import { Settings } from "#schema";
import { loadSettings, getSetting } from "#methods/settings/cache.js";
import { ensureLegalPages } from "#methods/pages/legalPages.js";

const FORCE = process.argv.includes("--force");

async function main() {
  const uri =
    process.env.MONGO_URI ||
    process.env.MONGODB_URI ||
    process.env.MONGO_URL ||
    process.env.DATABASE_URL;
  if (!uri) throw new Error("No Mongo connection string in the environment");

  await mongoose.connect(uri);
  await loadSettings(Settings);

  const { created, updated } = await ensureLegalPages({ force: FORCE, log: console.log });
  if (!created.length && !updated.length) console.log("  = nothing to do (use --force to overwrite)");
  console.log(`\nDone for ${getSetting("domain")}.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("seed-legal-pages failed:", err.message);
  process.exit(1);
});
