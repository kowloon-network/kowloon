// scripts/rerender-bodies.js
//
// One-off backfill for the inline-image privacy fix (methods/files/
// proxyBodyImages.js). New/edited Posts and Replies get external <img> src
// rewritten to local copies at render time, but bodies stored before that
// keep pointing at third-party hosts until re-rendered. This rewrites them.
//
// Dry run by default -- reports what would change, writes nothing:
//   node scripts/rerender-bodies.js
// Apply:
//   node scripts/rerender-bodies.js --apply
//
// Applies via raw collection updates of body/summary (+ the FeedItems
// mirror) rather than doc.save(), so no other pre-save side effects run
// (signature re-sign, Event RSVP circle creation, derived counts).
// Requires MONGO_URI and the S3_* storage env (images are downloaded).

import "dotenv/config";
import mongoose from "mongoose";
import { Post, Reply, FeedItems, Settings } from "#schema";
import proxyBodyImages, { isExternalImageUrl } from "#methods/files/proxyBodyImages.js";
import { loadSettings } from "#methods/settings/cache.js";
import { getServerSettings } from "#methods/settings/schemaHelpers.js";

const APPLY = process.argv.includes("--apply");
const uri =
  process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL || process.env.DATABASE_URL;

function hasExternalImg(html, domain) {
  if (!html) return false;
  for (const m of String(html).matchAll(/<img\b[^>]*?\bsrc="([^"]*)"/gi)) {
    if (isExternalImageUrl(m[1].replace(/&amp;/g, "&"), domain)) return true;
  }
  return false;
}

async function run() {
  await mongoose.connect(uri);
  try {
    await loadSettings(Settings);
  } catch {
    /* falls back to env DOMAIN */
  }
  const { domain } = getServerSettings();
  console.log(`[rerender-bodies] domain=${domain} mode=${APPLY ? "APPLY" : "dry-run"}`);

  const jobs = [
    { name: "Post", Model: Post, parentOf: (d) => d.id },
    // Reply images are owned by the root target (Reply.to is always "").
    { name: "Reply", Model: Reply, parentOf: (d) => d.target },
  ];

  for (const { name, Model, parentOf } of jobs) {
    let candidates = 0;
    let changed = 0;
    const cursor = Model.collection.find(
      { deletedAt: null, body: /<img\b/i },
      { projection: { id: 1, actorId: 1, target: 1, body: 1, summary: 1 } }
    );
    for await (const d of cursor) {
      const fields = ["body", "summary"].filter((f) => hasExternalImg(d[f], domain));
      if (!fields.length) continue;
      candidates++;
      if (!APPLY) {
        console.log(`  would rewrite ${name} ${d.id} (${fields.join(", ")})`);
        continue;
      }
      const $set = {};
      const feed$set = {};
      for (const f of fields) {
        $set[f] = await proxyBodyImages(d[f], {
          domain,
          actorId: d.actorId,
          parentObject: parentOf(d),
        });
        feed$set[`object.${f}`] = $set[f];
      }
      await Model.collection.updateOne({ _id: d._id }, { $set });
      await FeedItems.collection.updateOne({ id: d.id }, { $set: feed$set });
      changed++;
      console.log(`  rewrote ${name} ${d.id}`);
    }
    console.log(`[rerender-bodies] ${name}: ${candidates} with external images, ${changed} rewritten`);
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
