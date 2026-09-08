#!/usr/bin/env node
// /workers/feedFanOut.js
// DEPRECATED: FeedFanOut records are now created synchronously at post time.
// This worker is kept for potential future maintenance tasks only.
//
// The Feed collection is also deprecated - FeedFanOut + FeedItems is now
// the complete feed system.

import "dotenv/config";
import mongoose from "mongoose";
import { Settings } from "#schema";
import { loadSettings } from "#methods/settings/cache.js";

const POLL_INTERVAL_MS = 60000; // Check every minute for maintenance tasks

/**
 * Main worker loop - currently just a placeholder for maintenance
 */
async function run() {
  console.log("Feed maintenance worker started (fan-out is now synchronous)");

  while (true) {
    try {
      // Future: Add maintenance tasks here
      // - Clean up orphaned FeedFanOut records
      // - Sync FeedItems with source collections
      // - etc.

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    } catch (err) {
      console.error("Worker error:", err);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
}

// Connect to MongoDB and start worker
async function main() {
  try {
    // Check multiple env variable names for MongoDB URI (match main server behavior)
    const mongoUri =
      process.env.MONGO_URI ||
      process.env.MONGO_URL ||
      process.env.MONGODB_URI ||
      process.env.DATABASE_URL ||
      "mongodb://localhost:27017/kowloon";
    await mongoose.connect(mongoUri);
    console.log("Connected to MongoDB");

    // Load settings cache
    await loadSettings(Settings);
    console.log("Settings cache loaded");

    await run();
  } catch (err) {
    console.error("Failed to start worker:", err);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on("SIGINT", async () => {
  console.log("Shutting down worker...");
  await mongoose.disconnect();
  process.exit(0);
});

main();
