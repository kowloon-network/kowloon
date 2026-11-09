#!/usr/bin/env node
// scripts/dedupe-activity-keys.js
//
// One-off migration for the unique indexes added in schema/Activity.js,
// schema/React.js, schema/Post.js, schema/Reply.js and schema/Page.js.
// A unique index cannot be built while duplicates exist, and Mongoose
// autoIndex will NOT replace an existing index that has the same key pattern
// but different options -- so this script must run (with --apply) against
// each site's database BEFORE the new code is deployed.
//
// What it does:
//   1. Activity.remoteId duplicates        -> keep the oldest, $unset remoteId on the rest
//   2. Activity {actorId, dedupeKey} dups  -> keep the oldest, $unset dedupeKey on the rest
//      (Activities are an audit trail; we strip the key, never delete the row.)
//   3. React {actorId, target} duplicates  -> keep the NEWEST, delete the rest, then
//      recompute each affected target's reactCount/preview/summary
//      (syncTargetReactState from ActivityParser/handlers/React).
//   4. Duplicate `id` strings on Activity/Post/Reply/React/Page -> REPORTED.
//      (Ids are minted from _id, but a Create carrying a client-supplied
//      object.id can copy an existing one -- seen on local dev.) By default the
//      unique id index for that collection is skipped. With --remint-dup-ids
//      (plus --apply), the doc whose id matches its own _id is kept and every
//      other doc in the group gets a fresh id minted from ITS OWN _id
//      (<prefix>:<_id>@<domain>) -- nothing is deleted; each change is logged.
//   5. Drops the old non-unique activities indexes remoteId_1 and dedupeKey_1,
//      then builds every schema index for those five models (createIndexes,
//      which only ADDS missing indexes -- it never drops anything).
//
// Dry-run by default: read-only (aggregations + listIndexes). Nothing is
// written, no index is built. Pass --apply to act.
//
// Usage (once per site database):
//   MONGO_URI=mongodb://.../<db> node scripts/dedupe-activity-keys.js           # report
//   MONGO_URI=mongodb://.../<db> node scripts/dedupe-activity-keys.js --apply   # fix + build indexes
//   node scripts/dedupe-activity-keys.js --uri=mongodb://.../<db> [--apply] [--remint-dup-ids]

import "dotenv/config";
import mongoose from "mongoose";

const APPLY = process.argv.includes("--apply");
const REMINT = process.argv.includes("--remint-dup-ids");
const uriArg = process.argv.find((a) => a.startsWith("--uri="));
const MONGO_URI =
  (uriArg && uriArg.slice("--uri=".length)) ||
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  process.env.MONGO_URL ||
  process.env.DATABASE_URL;

if (!MONGO_URI) {
  console.error("Missing MONGO_URI (or --uri=).");
  process.exit(1);
}

// Must be set BEFORE any model is compiled, otherwise Mongoose starts building
// indexes / creating collections on connect -- which would make the dry run
// write, and would race the dedupe in --apply mode.
mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const { Activity, Post, Reply, React, Page } = await import("#schema");
const { syncTargetReactState } = await import("#ActivityParser/handlers/React/index.js");

const redact = (u) => u.replace(/\/\/([^@/]+)@/, "//***@");
const tag = APPLY ? "[apply]" : "[dry-run]";

async function dupGroups(Model, keyFields, extraMatch = {}, sort = { createdAt: 1, _id: 1 }) {
  const match = { ...extraMatch };
  for (const f of keyFields) match[f] = { ...(match[f] || {}), $type: "string" };
  const _id = Object.fromEntries(keyFields.map((f) => [f, `$${f}`]));
  return Model.aggregate([
    { $match: match },
    { $sort: sort },
    { $group: { _id, ids: { $push: "$_id" }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]).allowDiskUse(true);
}

async function stripKey(Model, label, keyFields, unsetField) {
  const groups = await dupGroups(Model, keyFields);
  const extra = groups.reduce((n, g) => n + g.n - 1, 0);
  console.log(`${tag} ${label}: ${groups.length} duplicated keys, ${extra} extra docs`);
  for (const g of groups.slice(0, 5)) console.log("    e.g.", JSON.stringify(g._id), "x", g.n);
  if (APPLY && extra) {
    const losers = groups.flatMap((g) => g.ids.slice(1)); // keep the oldest
    const r = await Model.updateMany({ _id: { $in: losers } }, { $unset: { [unsetField]: "" } });
    console.log(`    unset ${unsetField} on ${r.modifiedCount} docs`);
  }
}

async function dedupeReacts() {
  // Keep the newest reaction (most recent user intent).
  const groups = await dupGroups(React, ["actorId", "target"], {}, { updatedAt: -1, createdAt: -1, _id: -1 });
  const extra = groups.reduce((n, g) => n + g.n - 1, 0);
  console.log(`${tag} React {actorId,target}: ${groups.length} duplicated pairs, ${extra} extra docs`);
  for (const g of groups.slice(0, 5)) console.log("    e.g.", JSON.stringify(g._id), "x", g.n);
  if (APPLY && extra) {
    const losers = groups.flatMap((g) => g.ids.slice(1));
    const r = await React.deleteMany({ _id: { $in: losers } });
    console.log(`    deleted ${r.deletedCount} duplicate reacts`);
    const targets = [...new Set(groups.map((g) => g._id.target))];
    for (const t of targets) await syncTargetReactState(t);
    console.log(`    resynced react state on ${targets.length} targets`);
  }
}

// Returns the set of model names whose `id` has duplicates (unique id index unsafe).
async function checkIds() {
  const bad = new Set();
  for (const [name, Model] of Object.entries({ Activity, Post, Reply, React, Page })) {
    const groups = await dupGroups(Model, ["id"]);
    if (groups.length && APPLY && REMINT) {
      for (const g of groups) {
        const [prefix, rest] = g._id.id.split(/:(.*)/s);
        const domain = rest.split("@").pop();
        const docs = await Model.find({ _id: { $in: g.ids } }).select("_id id").lean();
        const keeper = docs.find((d) => d.id === `${prefix}:${d._id}@${domain}`) || docs[0];
        for (const d of docs) {
          if (String(d._id) === String(keeper._id)) continue;
          const fresh = `${prefix}:${d._id}@${domain}`;
          await Model.updateOne({ _id: d._id }, { $set: { id: fresh } });
          console.log(`    ${name} _id=${d._id}: id ${d.id} -> ${fresh}`);
        }
      }
      console.log(`${tag} ${name}.id: re-minted ids in ${groups.length} duplicate groups`);
      continue;
    }
    if (groups.length) {
      bad.add(name);
      console.log(`${tag} ${name}.id: ${groups.length} DUPLICATED ids -- resolve manually; unique id index skipped`);
      for (const g of groups.slice(0, 5)) console.log("    e.g.", g._id.id, "x", g.n);
    } else {
      console.log(`${tag} ${name}.id: no duplicates`);
    }
  }
  return bad;
}

async function listIndexNames(Model) {
  try {
    return (await Model.collection.indexes()).map((i) => i.name);
  } catch (err) {
    if (err?.codeName === "NamespaceNotFound" || err?.code === 26) return [];
    throw err;
  }
}

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log(`${tag} connected to ${redact(MONGO_URI)} (db: ${mongoose.connection.name})`);

  await stripKey(Activity, "Activity.remoteId", ["remoteId"], "remoteId");
  await stripKey(Activity, "Activity {actorId,dedupeKey}", ["actorId", "dedupeKey"], "dedupeKey");
  await dedupeReacts();
  const badIds = await checkIds();

  const actIdx = await listIndexNames(Activity);
  const legacy = ["remoteId_1", "dedupeKey_1"].filter((n) => actIdx.includes(n));
  console.log(`${tag} legacy activities indexes present: ${legacy.join(", ") || "none"}`);

  if (!APPLY) {
    console.log("\nDry run only -- nothing written. Re-run with --apply to fix and build indexes.");
    return;
  }

  for (const n of legacy) {
    await Activity.collection.dropIndex(n);
    console.log(`    dropped activities.${n}`);
  }

  for (const [name, Model] of Object.entries({ Activity, Post, Reply, React, Page })) {
    if (badIds.has(name)) {
      // Build everything except the unique id index.
      for (const [fields, opts] of Model.schema.indexes()) {
        if (Object.keys(fields).length === 1 && fields.id === 1 && opts?.unique) continue;
        await Model.collection.createIndex(fields, opts);
      }
      console.log(`    ${name}: indexes built (unique id index SKIPPED)`);
    } else {
      await Model.createIndexes();
      console.log(`    ${name}: indexes built`);
    }
  }
  console.log("\nDone.");
}

main()
  .catch((err) => {
    console.error("FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
