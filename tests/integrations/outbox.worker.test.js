// Outbound federation worker: atomic claim (no double-send when batches
// overlap), due-only selection (backed-off jobs don't starve due ones), and
// expired-lease re-queue.
import Outbox from "#schema/Outbox.js";
import { processOutboxBatch } from "#methods/federation/outboxWorker.js";

const realFetch = global.fetch;
let sends;

function mkJob(n, deliveryOverrides = {}) {
  return Outbox.create({
    activityId: `activity:test${n}@x`,
    activity: { type: "Create", id: `activity:test${n}@x` },
    createdBy: "@a@x",
    deliveries: [
      {
        target: `@b${n}@remote.example`,
        inboxUrl: `https://remote.example/inbox/${n}`,
        host: "remote.example",
        idempotencyKey: `k${n}`,
        ...deliveryOverrides,
      },
    ],
  });
}

beforeEach(async () => {
  await Outbox.deleteMany({});
  sends = [];
  global.fetch = async (url, opts) => {
    sends.push(url);
    expect(opts.signal).toBeDefined(); // real timeout, not the ignored `timeout` option
    await new Promise((r) => setTimeout(r, 50));
    return new Response("ok", { status: 202 });
  };
});

afterAll(() => {
  global.fetch = realFetch;
});

test("overlapping batches deliver each delivery exactly once", async () => {
  await mkJob(1);
  await mkJob(2);
  await Promise.all([processOutboxBatch(), processOutboxBatch(), processOutboxBatch()]);
  expect(sends.sort()).toEqual([
    "https://remote.example/inbox/1",
    "https://remote.example/inbox/2",
  ]);
  const jobs = await Outbox.find({}).lean();
  for (const j of jobs) {
    expect(j.deliveries[0].status).toBe("delivered");
    expect(j.deliveries[0].attempts).toBe(1);
    expect(j.status).toBe("delivered");
    expect(j.counts.pending).toBe(0);
  }
});

test("backed-off jobs do not starve due ones", async () => {
  const future = new Date(Date.now() + 3600_000);
  for (let i = 0; i < 12; i++) await mkJob(100 + i, { nextAttemptAt: future });
  await mkJob(999);
  await processOutboxBatch();
  expect(sends).toEqual(["https://remote.example/inbox/999"]);
});

test("expired lease is re-queued and delivered", async () => {
  await mkJob(7, {
    status: "delivering",
    leaseUntil: new Date(Date.now() - 1000),
    attempts: 1,
  });
  await processOutboxBatch();
  expect(sends).toEqual(["https://remote.example/inbox/7"]);
  const j = await Outbox.findOne({}).lean();
  expect(j.deliveries[0].status).toBe("delivered");
  expect(j.deliveries[0].attempts).toBe(2);
});

test("live lease is not stolen", async () => {
  await mkJob(8, {
    status: "delivering",
    leaseUntil: new Date(Date.now() + 60_000),
    attempts: 1,
  });
  await processOutboxBatch();
  expect(sends).toEqual([]);
});
