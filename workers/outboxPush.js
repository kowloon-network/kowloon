#!/usr/bin/env node
// /workers/outboxPush.js
// Background worker for processing outbound federation deliveries

import mongoose from "mongoose";
import { startOutboxWorker } from "#methods/federation/outboxWorker.js";
import logger from "#methods/utils/logger.js";
import redactUri from "#methods/utils/redactUri.js";
import { Settings } from "#schema";
import { loadSettings } from "#methods/settings/cache.js";
import { startHeartbeat } from "#methods/workers/heartbeat.js";

// Configuration from environment
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/kowloon";
const POLL_INTERVAL_MS = parseInt(process.env.OUTBOX_PUSH_INTERVAL_MS || "5000", 10);

/**
 * Main worker entry point
 */
async function main() {
  logger.info("Outbox push worker starting", {
    mongoUri: redactUri(MONGO_URI),
    pollIntervalMs: POLL_INTERVAL_MS,
  });

  // Connect to MongoDB
  try {
    await mongoose.connect(MONGO_URI);
    logger.info("Connected to MongoDB");
    await loadSettings(Settings);
    startHeartbeat("outbox");
    logger.info("Settings cache loaded");
  } catch (err) {
    logger.error("MongoDB connection failed", {
      error: err.message,
      stack: err.stack,
    });
    process.exit(1);
  }

  // Start the outbox worker
  const handle = startOutboxWorker(POLL_INTERVAL_MS);

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info(`Received ${signal}, shutting down gracefully`);
    clearInterval(handle);
    await mongoose.disconnect();
    logger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  logger.info("Outbox push worker ready", {
    pollIntervalMs: POLL_INTERVAL_MS,
  });
}

// Run
main().catch((err) => {
  logger.error("Outbox push worker fatal error", {
    error: err.message,
    stack: err.stack,
  });
  process.exit(1);
});
