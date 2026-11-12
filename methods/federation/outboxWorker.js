// /methods/federation/outboxWorker.js
// Worker to process outbox deliveries with retries and exponential backoff

import Outbox from "#schema/Outbox.js";
import signHttpRequest from "./signHttpRequest.js";
import log from "#methods/utils/logger.js";
import { canDeliverTo } from "#methods/moderation/federationPolicy.js";

// Configuration
const CONFIG = {
  batchSize: 10, // Process N deliveries per tick
  maxAttempts: 5, // Max retry attempts per delivery
  baseDelayMs: 1000, // Base delay for exponential backoff (1s)
  maxDelayMs: 3600000, // Max delay cap (1 hour)
  hostConcurrency: 2, // Max concurrent deliveries per host
  globalConcurrency: 10, // Max total concurrent deliveries
  responseBodyMaxBytes: 1024, // Max response body to store
  requestTimeoutMs: 10000, // Per-delivery HTTP timeout
  // Claim lease. A delivery is claimed (pending -> delivering) right before
  // its send; if the worker dies before writing the result, the lease expires
  // and the delivery is re-queued. Must comfortably exceed requestTimeoutMs.
  leaseMs: 60000,
};

/**
 * Calculate next attempt time using exponential backoff
 * @param {number} attempts - Number of previous attempts
 * @returns {Date} Next attempt time
 */
function calculateNextAttempt(attempts) {
  const delayMs = Math.min(
    CONFIG.baseDelayMs * Math.pow(2, attempts),
    CONFIG.maxDelayMs
  );
  return new Date(Date.now() + delayMs);
}

/**
 * Truncate response body to max size
 * @param {string} body - Response body
 * @returns {string} Truncated body
 */
function truncateBody(body) {
  if (!body || typeof body !== "string") return "";
  if (body.length <= CONFIG.responseBodyMaxBytes) return body;
  return body.slice(0, CONFIG.responseBodyMaxBytes) + "... [truncated]";
}

/**
 * Send activity to remote inbox
 * @param {Object} delivery - The delivery to process
 * @param {Object} activity - The activity to send
 * @returns {Promise<Object>} Result of the delivery attempt
 */
async function sendToInbox(delivery, activity) {
  const t0 = Date.now();

  try {
    // Prepare body
    const body = JSON.stringify(activity);
    const bytesSent = Buffer.byteLength(body, "utf8");

    // Sign request
    const { headers } = await signHttpRequest({
      method: "POST",
      url: delivery.inboxUrl,
      headers: {
        "Content-Type": "application/activity+json",
        "Idempotency-Key": delivery.idempotencyKey,
      },
      body,
    });

    // Send request
    const response = await fetch(delivery.inboxUrl, {
      method: "POST",
      headers,
      body,
      // `timeout` is not a Node fetch option (it was silently ignored, so a
      // hung peer stalled the worker indefinitely). AbortSignal.timeout is.
      signal: AbortSignal.timeout(CONFIG.requestTimeoutMs),
    });

    const latencyMs = Date.now() - t0;
    const responseBody = await response.text();
    const bytesReceived = Buffer.byteLength(responseBody, "utf8");

    // Extract Location header (remote activity ID)
    const location = response.headers.get("location");

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: truncateBody(responseBody),
      location,
      metrics: { latencyMs, bytesSent, bytesReceived },
    };
  } catch (err) {
    const latencyMs = Date.now() - t0;

    return {
      ok: false,
      status: null,
      error: {
        message: err.message,
        code: err.code || "UNKNOWN",
        class: err.constructor.name,
      },
      metrics: { latencyMs, bytesSent: 0, bytesReceived: 0 },
    };
  }
}

/**
 * Process a single delivery
 * @param {Object} job - The outbox job
 * @param {Object} delivery - The delivery to process
 * @returns {Promise<Object>} Updated delivery
 */
async function processDelivery(job, delivery) {
  // status/attempts/lastAttemptAt/leaseUntil were already set atomically by
  // claimDelivery(); this only computes the outcome.

  // A recipient blocked or defederated after this job was queued.
  if (!(await canDeliverTo(delivery))) {
    delivery.status = "skipped";
    delivery.error = {
      message: "Recipient is blocked or defederated",
      code: "BLOCKED",
      class: "PermanentFailure",
    };
    delivery.nextAttemptAt = null;
    return delivery;
  }

  // Send to inbox
  const result = await sendToInbox(delivery, job.activity);

  // Update metrics
  delivery.metrics = result.metrics;

  // Handle response
  if (result.ok) {
    // Success: 2xx response
    delivery.status = "delivered";
    delivery.responseStatus = result.status;
    delivery.responseHeaders = result.headers;
    delivery.responseBody = result.body;
    delivery.remoteActivityId = result.location || null;
    delivery.error = null;
    delivery.nextAttemptAt = null;

    log.info("Delivery succeeded", {
      jobId: job.id,
      target: delivery.target,
      host: delivery.host,
      status: result.status,
      attempts: delivery.attempts,
      latencyMs: result.metrics.latencyMs,
    });
  } else if (result.status === 410 || result.status === 404) {
    // 410 Gone or 404 Not Found: permanent failure (actor/inbox doesn't exist)
    delivery.status = "skipped";
    delivery.responseStatus = result.status;
    delivery.responseHeaders = result.headers;
    delivery.responseBody = result.body;
    delivery.error = {
      message: `Actor or inbox not found (${result.status})`,
      code: "NOT_FOUND",
      class: "PermanentFailure",
    };
    delivery.nextAttemptAt = null;

    log.warn("Delivery skipped (not found)", {
      jobId: job.id,
      target: delivery.target,
      host: delivery.host,
      status: result.status,
    });
  } else if (result.status >= 400 && result.status < 500) {
    // 4xx client error: permanent failure after a few quick retries
    if (delivery.attempts >= 2) {
      delivery.status = "failed";
      delivery.nextAttemptAt = null;
    } else {
      // Quick retry for auth/clock skew issues
      delivery.status = "pending";
      delivery.nextAttemptAt = new Date(Date.now() + 5000); // 5s
    }

    delivery.responseStatus = result.status;
    delivery.responseHeaders = result.headers;
    delivery.responseBody = result.body;
    delivery.error = {
      message: `Client error: ${result.statusText || result.status}`,
      code: "CLIENT_ERROR",
      class: "ClientError",
    };

    log.warn("Delivery failed (client error)", {
      jobId: job.id,
      target: delivery.target,
      host: delivery.host,
      status: result.status,
      attempts: delivery.attempts,
    });
  } else if (result.status >= 500 || result.error) {
    // 5xx server error or network error: retry with exponential backoff
    if (delivery.attempts >= CONFIG.maxAttempts) {
      delivery.status = "failed";
      delivery.nextAttemptAt = null;
    } else {
      delivery.status = "pending";
      delivery.nextAttemptAt = calculateNextAttempt(delivery.attempts);
    }

    delivery.responseStatus = result.status;
    delivery.responseHeaders = result.headers;
    delivery.responseBody = result.body;
    delivery.error = result.error || {
      message: `Server error: ${result.statusText || result.status}`,
      code: "SERVER_ERROR",
      class: "ServerError",
    };

    log.warn("Delivery failed (will retry)", {
      jobId: job.id,
      target: delivery.target,
      host: delivery.host,
      status: result.status,
      attempts: delivery.attempts,
      nextAttemptAt: delivery.nextAttemptAt,
      error: delivery.error.message,
    });
  }

  return delivery;
}

// Due = pending and (no nextAttemptAt or nextAttemptAt <= now).
function dueDeliveryMatch(now) {
  return {
    status: "pending",
    $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
  };
}

/**
 * Re-queue deliveries whose claim lease expired (worker crashed / was killed
 * mid-send). leaseUntil null/missing on a "delivering" row is also treated as
 * expired so nothing can get stuck in "delivering" forever.
 */
async function requeueExpiredLeases(now) {
  const expired = { $not: { $gte: now } };
  await Outbox.updateMany(
    { deliveries: { $elemMatch: { status: "delivering", leaseUntil: expired } } },
    {
      $set: {
        "deliveries.$[d].status": "pending",
        "deliveries.$[d].leaseUntil": null,
      },
    },
    { arrayFilters: [{ "d.status": "delivering", "d.leaseUntil": expired }] }
  );
}

/**
 * Atomically claim one due delivery (pending -> delivering + lease). Returns
 * the claimed delivery (plain object, attempts already incremented) or null
 * if another worker/tick got it first. This is what prevents two workers (or
 * two overlapping ticks) from sending the same delivery twice.
 */
async function claimDelivery(jobId, deliveryId) {
  const now = new Date();
  const claimed = await Outbox.findOneAndUpdate(
    {
      _id: jobId,
      deliveries: { $elemMatch: { _id: deliveryId, ...dueDeliveryMatch(now) } },
    },
    {
      $set: {
        "deliveries.$.status": "delivering",
        "deliveries.$.lastAttemptAt": now,
        "deliveries.$.leaseUntil": new Date(now.getTime() + CONFIG.leaseMs),
      },
      $inc: { "deliveries.$.attempts": 1 },
    },
    { new: true }
  ).lean();
  if (!claimed) return null;
  const delivery = claimed.deliveries.find((d) => String(d._id) === String(deliveryId));
  return delivery ? { job: claimed, delivery } : null;
}

const RESULT_FIELDS = [
  "status",
  "responseStatus",
  "responseHeaders",
  "responseBody",
  "remoteActivityId",
  "error",
  "nextAttemptAt",
  "metrics",
];

/**
 * Write a delivery's outcome back atomically (only if we still hold the claim),
 * then re-save the job so the pre-save hook recomputes status/counts.
 */
async function writeDeliveryResult(jobId, delivery) {
  // An outcome processDelivery() doesn't classify (e.g. a 3xx) would leave the
  // row "delivering" -- back it off like a transient error rather than
  // letting the expired-lease sweep re-send it every tick.
  if (delivery.status === "delivering") {
    const exhausted = delivery.attempts >= CONFIG.maxAttempts;
    delivery.status = exhausted ? "failed" : "pending";
    delivery.nextAttemptAt = exhausted ? null : calculateNextAttempt(delivery.attempts);
  }
  const $set = { "deliveries.$.leaseUntil": null };
  for (const f of RESULT_FIELDS) {
    if (delivery[f] !== undefined) $set[`deliveries.$.${f}`] = delivery[f];
  }
  await Outbox.updateOne(
    { _id: jobId, deliveries: { $elemMatch: { _id: delivery._id, status: "delivering" } } },
    { $set }
  );
  const jobDoc = await Outbox.findById(jobId);
  if (jobDoc) {
    jobDoc.lastAttemptedAt = new Date();
    await jobDoc.save(); // pre-save hook recalculates job status + counts
  }
}

/**
 * Find and process due deliveries
 * @returns {Promise<number>} Number of deliveries processed
 */
export async function processOutboxBatch() {
  const now = new Date();

  await requeueExpiredLeases(now);

  // Only pick jobs that actually have a DUE delivery. Previously this matched
  // any job with counts.pending > 0, so the first batchSize jobs whose pending
  // deliveries were all backed off (nextAttemptAt in the future) filled every
  // batch and starved due work behind them. Oldest-attempted first.
  const jobs = await Outbox.find({
    deliveries: { $elemMatch: dueDeliveryMatch(now) },
  })
    .sort({ lastAttemptedAt: 1 })
    .limit(CONFIG.batchSize)
    .select("_id id deliveries._id deliveries.status deliveries.nextAttemptAt")
    .lean();

  if (jobs.length === 0) {
    return 0;
  }

  let processed = 0;

  for (const job of jobs) {
    // Find deliveries that are due
    const dueDeliveries = job.deliveries.filter((d) => {
      if (d.status !== "pending") return false;
      if (!d.nextAttemptAt) return true; // No next attempt = immediately available
      return new Date(d.nextAttemptAt) <= now;
    });

    if (dueDeliveries.length === 0) continue;

    // Process each delivery (TODO: respect host concurrency limits)
    for (const candidate of dueDeliveries) {
      try {
        const claim = await claimDelivery(job._id, candidate._id);
        if (!claim) continue; // someone else claimed it, or no longer due

        const updatedDelivery = await processDelivery(claim.job, claim.delivery);
        await writeDeliveryResult(job._id, updatedDelivery);

        processed++;
      } catch (err) {
        log.error("Error processing delivery", {
          jobId: job.id,
          deliveryId: candidate._id,
          error: err.message,
          stack: err.stack,
        });
      }
    }
  }

  if (processed > 0) {
    log.info("Outbox batch processed", {
      jobsChecked: jobs.length,
      deliveriesProcessed: processed,
    });
  }

  return processed;
}

/**
 * Start the outbox worker (polls for due work)
 * @param {number} intervalMs - Polling interval in milliseconds
 * @returns {NodeJS.Timeout} The interval handle
 */
export function startOutboxWorker(intervalMs = 5000) {
  log.info("Starting outbox worker", { intervalMs });

  // setInterval fires regardless of whether the previous batch finished; a
  // slow batch (up to batchSize x deliveries x 10s) would overlap the next
  // tick and re-send. Skip ticks while a batch is still running.
  let running = false;
  const tick = async (label) => {
    if (running) return;
    running = true;
    try {
      await processOutboxBatch();
    } catch (err) {
      log.error(label, {
        error: err.message,
        stack: err.stack,
      });
    } finally {
      running = false;
    }
  };

  const handle = setInterval(() => tick("Outbox worker error"), intervalMs);

  // Process immediately on start
  tick("Initial outbox worker error");

  return handle;
}

export default {
  processOutboxBatch,
  startOutboxWorker,
};
