// GET /health -- is this server working?
//
//   status "ok"        everything is up
//   status "degraded"  the site works, but a background worker has stopped
//                      (posts may not reach other servers, uploads may not
//                      process, backups may not run)
//   status "error"     the database or file storage is unreachable -- HTTP 503
//
// Open to any origin so the setup wizard can poll it cross-origin from
// http://server-ip:2999 during installation, and cheap enough for an uptime
// monitor to call every minute.

import express from "express";
import mongoose from "mongoose";

const router = express.Router({ mergeParams: true });

const STORAGE_TIMEOUT_MS = 3000;

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error(`no answer within ${ms / 1000}s`)), ms);
    }),
  ]);
}

// File storage is reachable if asking about a key that doesn't exist gets a
// clean "not there" rather than an error (bad credentials, missing bucket,
// MinIO down).
async function checkStorage() {
  try {
    const { getStorageAdapter } = await import("#methods/files/index.js");
    const storage = await getStorageAdapter();
    await withTimeout(storage.exists("__health-check"), STORAGE_TIMEOUT_MS);
    return { status: "connected" };
  } catch (err) {
    return { status: "unreachable", error: err.message };
  }
}

router.get("/", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  const timestamp = new Date().toISOString();

  try {
    const dbUp = mongoose.connection.readyState === 1;
    const storage = await checkStorage();

    let workers = {};
    if (dbUp) {
      const { workerStatus } = await import("#methods/workers/heartbeat.js");
      workers = await workerStatus();
    }

    const problems = [];
    if (!dbUp) problems.push("Database not connected");
    if (storage.status !== "connected") problems.push(`File storage unreachable: ${storage.error}`);
    const down = problems.length > 0;

    const stopped = Object.entries(workers)
      .filter(([, w]) => w.status !== "running")
      .map(([name, w]) => `${name} worker ${w.status}`);

    const body = {
      status: down ? "error" : stopped.length ? "degraded" : "ok",
      timestamp,
      services: {
        mongodb: dbUp ? "connected" : "disconnected",
        storage: storage.status,
        workers,
      },
    };
    if (down || stopped.length) body.message = [...problems, ...stopped].join("; ");

    res.status(down ? 503 : 200).json(body);
  } catch (error) {
    res.status(503).json({ status: "error", timestamp, message: error.message });
  }
});

export default router;
