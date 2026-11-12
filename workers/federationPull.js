#!/usr/bin/env node
// /workers/federationPull.js
// Simplified background worker for pre-caching remote content
// Polls remote servers periodically to keep local FeedItems fresh

import "dotenv/config";
import mongoose from "mongoose";
import { User, Circle, FederatedServer, Settings } from "#schema";
import { getSetting, loadSettings } from "#methods/settings/cache.js";
import { isDefederated } from "#methods/moderation/federationPolicy.js";
import { getServerSettings } from "#methods/settings/schemaHelpers.js";
import Kowloon from "#kowloon";
import logger from "#methods/utils/logger.js";

const POLL_INTERVAL_MS = parseInt(process.env.FEDERATION_PULL_INTERVAL_MS || "60000", 10); // 1 minute
const BATCH_SIZE = parseInt(process.env.FEDERATION_PULL_BATCH_SIZE || "10", 10);

/**
 * Extract domain from actor ID or URL
 */
function extractDomain(str) {
  if (!str) return null;
  // Only treat real URLs as URLs: `new URL("group:x@d")` parses with an
  // empty hostname, which silently dropped every remote group.
  if (/^https?:\/\//i.test(str)) {
    try {
      return new URL(str).hostname;
    } catch {
      return null;
    }
  }
  const parts = str.split("@").filter(Boolean);
  return parts[parts.length - 1];
}

// A bare-server member looks like "@kowloon.network" (one @ at start, no second @).
// A user member looks like "@alice@kowloon.network" (two @s).
function isServerEntry(id) {
  return typeof id === "string" && id.startsWith("@") && !id.slice(1).includes("@");
}

/**
 * Build aggregated pull parameters for a remote server
 * Combines all local users' interests in that server
 */
async function buildPullParamsForServer(remoteDomain) {
  const { domain: ourDomain } = getServerSettings();

  const aggregated = {
    authors: new Set(),
    members: new Set(),
    groups: new Set(),
  };

  // Only local users who actually have a member on this remote domain in one
  // of their circles go in `to`. Previously EVERY local user was sent as a
  // repeated `to=` query param (HTTP 431 at ~500 users), and each user cost
  // two Circle lookups. Same approach as pollWorker's follower map: one query
  // for circles containing members on that domain. Bare "@domain" server
  // entries are handled by processCircleServerPulls, so they're excluded here.
  const esc = remoteDomain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const circles = await Circle.find({
    "members.id": { $regex: `.@${esc}$`, $options: "i" },
    deletedAt: null,
  })
    .select("id actorId members.id")
    .lean();

  const ownerIds = [
    ...new Set(
      circles
        .map((c) => c.actorId)
        .filter((id) => typeof id === "string" && extractDomain(id) === ourDomain)
    ),
  ];
  if (ownerIds.length === 0) {
    return { authors: [], members: [], groups: [] };
  }

  const owners = await User.find({
    id: { $in: ownerIds },
    deletedAt: null,
    active: { $ne: false },
  })
    .select("id circles.blocked circles.muted")
    .lean();
  const activeOwners = new Set(owners.map((u) => u.id));
  // Blocked/Muted circles hold remote users too -- they are not follows.
  // So do the server's own Blocked/Defederated lists -- moderation, not
  // anyone's reading list.
  const excludedCircles = new Set(
    [
      ...owners.flatMap((u) => [u.circles?.blocked, u.circles?.muted]),
      getSetting("blockedCircle"),
      getSetting("defederatedCircle"),
    ].filter(Boolean)
  );

  for (const circle of circles) {
    if (!activeOwners.has(circle.actorId) || excludedCircles.has(circle.id)) continue;
    let interested = false;
    for (const member of circle.members || []) {
      const id = member?.id;
      if (typeof id !== "string" || isServerEntry(id)) continue;
      if (extractDomain(id) !== remoteDomain) continue;
      if (id.startsWith("group:")) aggregated.groups.add(id);
      else aggregated.authors.add(id);
      interested = true;
    }
    if (interested) aggregated.members.add(circle.actorId);
  }

  return {
    authors: Array.from(aggregated.authors),
    members: Array.from(aggregated.members),
    groups: Array.from(aggregated.groups),
  };
}

/**
 * Pull content from servers that users have added directly to circles as bare @domain entries.
 *
 * This is how the "subscribe to a whole server" feature works: a user adds e.g.
 * "@kowloon.network" (no username) to one of their circles. That tells the pull
 * worker to fetch all public posts from that server and deliver them to that user
 * whenever their circle timeline is loaded.
 *
 * Each unique domain found is pulled at most once per cycle. The FederatedServer
 * record is upserted so we track health/rate-limiting the same as for individual
 * user follows.
 */
async function processCircleServerPulls() {
  const { domain: ourDomain } = getServerSettings();
  const now = new Date();

  // Find all non-system circles that have at least one bare @domain member
  const circles = await Circle.find({
    type: { $ne: "System" },
    "members.id": { $regex: /^@[^@]+$/ },
  })
    .select("actorId members")
    .lean();

  if (!circles.length) return;

  // Map: domain -> Set of local user actorIds who have that server in a circle
  const domainToUsers = new Map();
  for (const circle of circles) {
    for (const member of circle.members) {
      if (!isServerEntry(member.id)) continue;
      const domain = member.id.slice(1); // "@kowloon.network" -> "kowloon.network"
      if (domain === ourDomain) continue; // never pull from ourselves
      if (!domainToUsers.has(domain)) domainToUsers.set(domain, new Set());
      domainToUsers.get(domain).add(circle.actorId);
    }
  }

  if (!domainToUsers.size) return;

  logger.info(`federationPull: Circle-server pull — ${domainToUsers.size} server(s)`);

  for (const [domain, userIds] of domainToUsers.entries()) {
    // Skip defederated servers. Blocked servers still get pulled — local
    // users who subscribed to them can still read their public content.
    if (await isDefederated(domain)) continue;
    const serverRecord = await FederatedServer.findOne({ domain }).lean();
    if (serverRecord?.nextPullAt && serverRecord.nextPullAt > now) continue;

    logger.info(`federationPull: Pulling circle-server ${domain}`, { users: userIds.size });

    try {
      const startTime = Date.now();
      const result = await Kowloon.federation.pullFromRemote({
        remoteDomain: domain,
        from: [`@${domain}`],
        to: [...userIds],
        // serverPullCursor = newest publishedAt received last time. Fallback
        // to lastPulledAt for records written before the cursor existed.
        since:
          serverRecord?.serverPullCursor ??
          serverRecord?.lastPulledAt ??
          new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        limit: 100,
      });
      const responseTimeMs = Date.now() - startTime;
      const itemCount = result.items?.length || 0;

      if (!result.error) {
        await FederatedServer.findOneAndUpdate(
          { domain },
          {
            $set: {
              lastPulledAt: now,
              lastPullAttemptedAt: now,
              pullErrorCount: 0,
              nextPullAt: new Date(now.getTime() + POLL_INTERVAL_MS),
              ...(result.newestPublishedAt ? { serverPullCursor: result.newestPublishedAt } : {}),
            },
            $setOnInsert: { domain },
          },
          { upsert: true }
        );
        await FederatedServer.restoreHealthyStatus(domain);
        logger.info(`federationPull: Circle-server ${domain} complete`, { items: itemCount, responseTimeMs });
      } else {
        await FederatedServer.findOneAndUpdate(
          { domain },
          {
            $set: { lastPullAttemptedAt: now },
            $inc: { pullErrorCount: 1 },
            $setOnInsert: { domain, status: "active" },
          },
          { upsert: true }
        );
        logger.warn(`federationPull: Circle-server ${domain} error`, { error: result.error });
      }
    } catch (error) {
      logger.error(`federationPull: Circle-server ${domain} exception`, { error: error.message });
    }
  }
}

/**
 * Process one batch of servers
 */
async function processBatch() {
  const now = new Date();

  // Get servers ready to be polled using new FederatedServer model
  const servers = await FederatedServer.getServersReadyForPull(BATCH_SIZE);

  if (servers.length === 0) {
    logger.info("federationPull: No servers ready to poll");
    return 0;
  }

  logger.info(`federationPull: Processing ${servers.length} servers`);

  let totalItems = 0;

  for (const server of servers) {
    const remoteDomain = server.domain;

    try {
      // Build aggregated pull parameters
      const params = await buildPullParamsForServer(remoteDomain);

      // Skip if no local interest
      if (
        params.authors.length === 0 &&
        params.members.length === 0 &&
        params.groups.length === 0
      ) {
        logger.info(`federationPull: No local interest in ${remoteDomain}`);

        // Update nextPullAt to avoid re-checking too soon
        await FederatedServer.findOneAndUpdate(
          { domain: remoteDomain },
          {
            $set: {
              nextPullAt: new Date(Date.now() + 3600000), // 1 hour
              lastPullAttemptedAt: now,
            },
          }
        );
        continue;
      }

      // Pull from remote server.
      // from = individual authors + group IDs to pull content for
      // to   = local user IDs who should receive the content
      const startTime = Date.now();
      const result = await Kowloon.federation.pullFromRemote({
        remoteDomain,
        from: [...params.authors, ...params.groups],
        to: params.members,
        since: server.pullCursor ?? server.lastPulledAt,
        limit: 100,
      });
      const responseTimeMs = Date.now() - startTime;

      const itemCount = result.items?.length || 0;
      totalItems += itemCount;

      // Update server using FederatedServer methods
      if (!result.error) {
        await FederatedServer.recordPullSuccess(remoteDomain, itemCount, responseTimeMs, result.newestPublishedAt);
      } else {
        await FederatedServer.recordPullError(remoteDomain, result.error);
      }

      logger.info(`federationPull: Completed ${remoteDomain}`, {
        items: itemCount,
        responseTimeMs,
        error: result.error,
      });
    } catch (error) {
      logger.error(`federationPull: Error processing ${remoteDomain}`, {
        error: error.message,
        stack: error.stack,
      });

      // Update server with error using FederatedServer
      await FederatedServer.recordPullError(remoteDomain, error.message);
    }
  }

  return totalItems;
}

/**
 * Main worker loop
 */
async function run() {
  logger.info("federationPull: Worker starting", {
    pollInterval: POLL_INTERVAL_MS,
    batchSize: BATCH_SIZE,
  });

  while (true) {
    try {
      const itemCount = await processBatch();
      await processCircleServerPulls();

      if (itemCount > 0) {
        logger.info(`federationPull: Retrieved ${itemCount} items`);
      }
    } catch (error) {
      logger.error("federationPull: Batch error", {
        error: error.message,
        stack: error.stack,
      });
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/**
 * Main entry point
 */
async function main() {
  try {
    // Connect to MongoDB
    const mongoUri =
      process.env.MONGO_URI ||
      process.env.MONGO_URL ||
      process.env.MONGODB_URI ||
      process.env.DATABASE_URL ||
      "mongodb://localhost:27017/kowloon";

    await mongoose.connect(mongoUri);
    logger.info("federationPull: Connected to MongoDB");

    // Load settings cache
    await loadSettings(Settings);
    logger.info("federationPull: Settings loaded");

    // Start worker loop
    await run();
  } catch (error) {
    logger.error("federationPull: Fatal error", {
      error: error.message,
      stack: error.stack,
    });
    process.exit(1);
  }
}

// Graceful shutdown
process.on("SIGINT", async () => {
  logger.info("federationPull: Shutting down");
  await mongoose.disconnect();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  logger.info("federationPull: Shutting down");
  await mongoose.disconnect();
  process.exit(0);
});

// Start worker if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export default { run, processBatch, buildPullParamsForServer, processCircleServerPulls };
