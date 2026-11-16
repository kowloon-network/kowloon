// GET /health reports the database, file storage and each background worker.
import { WorkerHeartbeat } from "#schema";
import { workerStatus, STALE_MS } from "#methods/workers/heartbeat.js";

test("workers are running, stopped or never seen", async () => {
  const now = Date.now();
  await WorkerHeartbeat.deleteMany({});
  await WorkerHeartbeat.create([
    { name: "outbox", lastBeatAt: new Date(now - 30 * 1000) },
    { name: "pull", lastBeatAt: new Date(now - STALE_MS - 1000) },
  ]);
  const w = await workerStatus(now);
  expect(w.outbox.status).toBe("running");
  expect(w.pull.status).toBe("stopped");
  expect(w.media.status).toBe("never seen");
  expect(w.backup.status).toBe("never seen");
});

test("/health lists every service", async () => {
  const res = await fetch(`${global.__TEST_BASE_URL__}/health`);
  const body = await res.json();
  expect(body.services.mongodb).toBe("connected");
  expect(["connected", "unreachable"]).toContain(body.services.storage);
  expect(Object.keys(body.services.workers).sort()).toEqual(["backup", "media", "outbox", "pull"]);
  // Database up: 200 unless storage is down (no storage in the test setup).
  expect(res.status).toBe(body.services.storage === "connected" ? 200 : 503);
  expect(body.status).not.toBe("ok"); // pull is stopped
});
