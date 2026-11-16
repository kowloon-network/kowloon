// methods/workers/heartbeat.js
// Background workers report in once a minute so GET /health can say which
// are running. A worker that hasn't reported for STALE_MS is shown as
// stopped.

import os from "node:os";
import { WorkerHeartbeat } from "#schema";

export const WORKERS = ["outbox", "pull", "media", "backup"];
export const BEAT_MS = 60 * 1000;
export const STALE_MS = 5 * 60 * 1000;

/** Start reporting in as `name`. Returns the interval handle. */
export function startHeartbeat(name) {
  const startedAt = new Date();
  const beat = () =>
    WorkerHeartbeat.updateOne(
      { name },
      { $set: { lastBeatAt: new Date(), startedAt, host: os.hostname() } },
      { upsert: true }
    ).catch(() => {}); // a missed beat only makes /health look worse
  beat();
  const handle = setInterval(beat, BEAT_MS);
  handle.unref?.();
  return handle;
}

/** { outbox: { status: "running"|"stopped"|"never seen", lastBeatAt }, ... } */
export async function workerStatus(now = Date.now()) {
  const rows = await WorkerHeartbeat.find({ name: { $in: WORKERS } }).lean();
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  const out = {};
  for (const name of WORKERS) {
    const row = byName[name];
    if (!row) out[name] = { status: "never seen" };
    else
      out[name] = {
        status: now - new Date(row.lastBeatAt).getTime() <= STALE_MS ? "running" : "stopped",
        lastBeatAt: row.lastBeatAt,
      };
  }
  return out;
}
