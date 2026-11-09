// methods/federation/pollWorker.js
// Background worker that periodically pulls new content from remote servers.
//
// For each Server record where scheduler.nextPollAt <= now:
//   1. Determine which remote actors local users are following (from actorsRefCount)
//   2. Find the local users who have those actors in their circles
//   3. Call pullFromRemote(domain, from, to, since) to fetch new FeedItems
//   4. Update scheduler state (nextPollAt, backoff on error)
//
// This is Kowloon-to-Kowloon protocol only. Standard AP push (from Mastodon etc.)
// is handled separately via the inbox route.

import { Server, Circle } from "#schema";
import pullFromRemote from "./pullFromRemote.js";
import logger from "#methods/utils/logger.js";

const CONFIG = {
  batchSize: 5,            // servers to process per tick
  defaultIntervalMs: 300_000,  // 5 minutes between successful polls
  minIntervalMs: 60_000,       // never poll faster than 1 minute
  maxBackoffMs: 3_600_000,     // cap backoff at 1 hour
  maxConsecutiveErrors: 10,    // give up after this many consecutive errors
  workerTickMs: 30_000,        // how often the worker checks for due servers
};

/**
 * Calculate next poll time after a successful poll.
 * Resets backoff to zero.
 */
function nextPollSuccess() {
  return new Date(Date.now() + CONFIG.defaultIntervalMs);
}

/**
 * Calculate next poll time after an error, using exponential backoff.
 */
function nextPollBackoff(errorCount) {
  const delayMs = Math.min(
    CONFIG.minIntervalMs * Math.pow(2, errorCount),
    CONFIG.maxBackoffMs
  );
  return new Date(Date.now() + delayMs);
}

/**
 * Given a set of remote actor IDs, find which local users have any of them
 * as members in one of their circles (i.e., are following them).
 *
 * Returns: Map<remoteActorId, Set<localUserId>>
 */
async function buildFollowerMap(remoteActorIds) {
  if (remoteActorIds.length === 0) return new Map();

  // Circles where a remote actor is a member = circles owned by local users
  // who follow that actor.
  const circles = await Circle.find({
    "members.id": { $in: remoteActorIds },
  })
    .select("actorId members.id")
    .lean();

  const followerMap = new Map(); // remoteActorId → Set of local userIds

  for (const circle of circles) {
    const localUserId = circle.actorId;
    for (const member of circle.members) {
      if (remoteActorIds.includes(member.id)) {
        if (!followerMap.has(member.id)) followerMap.set(member.id, new Set());
        followerMap.get(member.id).add(localUserId);
      }
    }
  }

  return followerMap;
}

/**
 * Process a single server: pull new content and update scheduler state.
 */
async function processServer(server) {
  const domain = server.domain;
  const t0 = Date.now();

  logger.info("pollWorker: polling", { domain });

  // Build from/to arrays from actorsRefCount.
  // actorsRefCount is an array of { id, count } objects (not a Map).
  const remoteActorIds = Array.isArray(server.actorsRefCount)
    ? server.actorsRefCount.map(e => e.id).filter(Boolean)
    : [];

  if (remoteActorIds.length === 0 && server.serverFollowersCount === 0) {
    // Nothing to pull — no local users follow this server
    await Server.updateOne(
      { _id: server._id },
      {
        $set: {
          "scheduler.nextPollAt": nextPollSuccess(),
          "scheduler.lastSuccessfulPollAt": new Date(),
        },
      }
    );
    return;
  }

  // Build follower map: remoteActorId → Set of local userIds
  const followerMap = await buildFollowerMap(remoteActorIds);

  // from: all remote actors that have at least one local follower
  const from = [...followerMap.keys()];

  // to: all unique local users who follow at least one remote actor
  const toSet = new Set();
  for (const localUsers of followerMap.values()) {
    for (const u of localUsers) toSet.add(u);
  }
  const to = [...toSet];

  if (from.length === 0 || to.length === 0) {
    // actorsRefCount has entries but no live circle memberships found.
    // This can happen after unfollows that didn't decrement the refcount.
    // Skip gracefully.
    logger.info("pollWorker: no live followers found, skipping", { domain });
    await Server.updateOne(
      { _id: server._id },
      { $set: { "scheduler.nextPollAt": nextPollSuccess() } }
    );
    return;
  }

  // pullCursor = newest remote publishedAt received last time (falls back to
  // the old wall-clock field for records that predate it).
  const since = server.scheduler?.pullCursor ?? server.scheduler?.lastSuccessfulPollAt ?? null;

  const result = await pullFromRemote({
    remoteDomain: domain,
    from,
    to,
    since,
    limit: server.maxPage ?? 100,
  });

  const elapsed = Date.now() - t0;

  if (result.error) {
    const errorCount = (server.scheduler?.errorCount ?? 0) + 1;
    const giveUp = errorCount >= CONFIG.maxConsecutiveErrors;

    logger.warn("pollWorker: pull failed", {
      domain,
      error: result.error,
      errorCount,
      giveUp,
      ms: elapsed,
    });

    await Server.updateOne(
      { _id: server._id },
      {
        $set: {
          "scheduler.nextPollAt": giveUp ? null : nextPollBackoff(errorCount),
          "scheduler.backoffMs": giveUp ? 0 : CONFIG.minIntervalMs * Math.pow(2, errorCount),
          "scheduler.errorCount": errorCount,
          "scheduler.lastError": String(result.error),
          "scheduler.lastErrorCode": classifyError(result.error),
          lastPullAttemptedAt: new Date(),
          lastPullError: String(result.error),
          pullErrorCount: errorCount,
          ...(giveUp ? { status: "limited" } : {}),
        },
      }
    );
    return;
  }

  // Success
  logger.info("pollWorker: pull succeeded", {
    domain,
    items: result.items?.length ?? 0,
    ms: elapsed,
  });

  await Server.updateOne(
    { _id: server._id },
    {
      $set: {
        "scheduler.nextPollAt": nextPollSuccess(),
        "scheduler.backoffMs": 0,
        "scheduler.errorCount": 0,
        "scheduler.lastError": undefined,
        "scheduler.lastErrorCode": undefined,
        "scheduler.lastSuccessfulPollAt": new Date(),
        ...(result.newestPublishedAt ? { "scheduler.pullCursor": result.newestPublishedAt } : {}),
        lastPulledAt: new Date(),
        lastPullAttemptedAt: new Date(),
        lastPullError: undefined,
        pullErrorCount: 0,
        "stats.itemsSeen": (server.stats?.itemsSeen ?? 0) + (result.items?.length ?? 0),
        "stats.lastItemAt": result.items?.length > 0 ? new Date() : server.stats?.lastItemAt,
      },
    }
  );
}

function classifyError(errorMsg) {
  const s = String(errorMsg).toLowerCase();
  if (s.includes("timeout") || s.includes("timed out")) return "ETIMEOUT";
  if (s.includes("connect") || s.includes("econnrefused") || s.includes("enotfound")) return "ECONN";
  if (s.includes("jwt") || s.includes("unauthorized") || s.includes("403")) return "EJWT";
  if (s.includes("tls") || s.includes("cert") || s.includes("ssl")) return "ETLS";
  if (s.includes("http")) return "EHTTP";
  if (s.includes("json") || s.includes("parse") || s.includes("format")) return "EFORMAT";
  return "EOTHER";
}

/**
 * Find and process servers whose nextPollAt is due.
 * Returns the number of servers processed.
 */
export async function processPollBatch() {
  const now = new Date();

  const servers = await Server.find({
    status: { $nin: ["blocked"] },
    "scheduler.nextPollAt": { $lte: now },
  })
    .limit(CONFIG.batchSize)
    .lean();

  if (servers.length === 0) return 0;

  // Process servers concurrently (bounded by batchSize)
  await Promise.allSettled(
    servers.map(async (server) => {
      try {
        await processServer(server);
      } catch (err) {
        logger.error("pollWorker: unexpected error processing server", {
          domain: server.domain,
          error: err.message,
          stack: err.stack,
        });
        // Bump error count and back off
        await Server.updateOne(
          { _id: server._id },
          {
            $inc: { "scheduler.errorCount": 1 },
            $set: {
              "scheduler.nextPollAt": nextPollBackoff(server.scheduler?.errorCount ?? 0),
              "scheduler.lastError": err.message,
            },
          }
        );
      }
    })
  );

  return servers.length;
}

/**
 * Start the poll worker.
 * @param {number} intervalMs - How often to check for due polls (default 30s)
 * @returns {NodeJS.Timeout} The interval handle (call clearInterval to stop)
 */
export function startPollWorker(intervalMs = CONFIG.workerTickMs) {
  logger.info("pollWorker: starting", { intervalMs });

  const handle = setInterval(async () => {
    try {
      const count = await processPollBatch();
      if (count > 0) {
        logger.info("pollWorker: batch complete", { serversProcessed: count });
      }
    } catch (err) {
      logger.error("pollWorker: tick error", {
        error: err.message,
        stack: err.stack,
      });
    }
  }, intervalMs);

  // Run immediately on start so we don't wait a full interval on boot
  processPollBatch().catch((err) => {
    logger.error("pollWorker: initial batch error", { error: err.message });
  });

  return handle;
}

export default { processPollBatch, startPollWorker };
