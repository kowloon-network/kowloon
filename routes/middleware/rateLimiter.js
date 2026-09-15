// /routes/middleware/rateLimiter.js

import crypto from "crypto";
import logger from "#methods/utils/logger.js";

// Store for tracking request counts per IP
// Structure: { ip: { count: number, resetTime: timestamp } }
const requestCounts = new Map();

// Cleanup old entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of requestCounts.entries()) {
    if (data.resetTime < now) {
      requestCounts.delete(ip);
    }
  }
}, 10 * 60 * 1000);

/**
 * Rate limiter middleware
 * @param {Object} options
 * @param {number} options.windowMs - Time window in milliseconds (default: 15 minutes)
 * @param {number} options.max - Max requests per window (default: 100)
 * @param {string} options.message - Error message when limit exceeded
 */
export function createRateLimiter({
  windowMs = 15 * 60 * 1000, // 15 minutes
  max = 100,
  message = "Too many requests, please try again later",
} = {}) {
  return function rateLimiter(req, res, next) {
    // Skip rate limiting if disabled via environment variable
    if (process.env.RATE_LIMITING_ENABLED === "false") {
      return next();
    }

    // Get client IP (handle proxies)
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
      req.headers["x-real-ip"] ||
      req.socket.remoteAddress ||
      req.connection.remoteAddress;

    const now = Date.now();
    const record = requestCounts.get(ip);

    // No record or window expired - start fresh
    if (!record || record.resetTime < now) {
      requestCounts.set(ip, {
        count: 1,
        resetTime: now + windowMs,
      });
      return next();
    }

    // Increment count
    record.count++;

    // Check if limit exceeded
    if (record.count > max) {
      const retryAfter = Math.ceil((record.resetTime - now) / 1000);
      res.set("Retry-After", String(retryAfter));
      res.set("X-RateLimit-Limit", String(max));
      res.set("X-RateLimit-Remaining", "0");
      res.set("X-RateLimit-Reset", String(record.resetTime));

      logger.warn("Rate limit exceeded", {
        ip,
        count: record.count,
        max,
        path: req.path,
      });

      return res.status(429).json({
        error: message,
        retryAfter,
      });
    }

    // Set rate limit headers
    res.set("X-RateLimit-Limit", String(max));
    res.set("X-RateLimit-Remaining", String(max - record.count));
    res.set("X-RateLimit-Reset", String(record.resetTime));

    next();
  };
}

// Preset configurations for different endpoint types
export const inboxRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per 15 minutes per IP
  message: "Too many inbox requests, please try again later",
});

export const outboxRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 200, // More lenient for outbox
  message: "Too many outbox requests, please try again later",
});

export const strictRateLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 20, // Very strict for sensitive endpoints
  message: "Too many requests, please try again later",
});

// For GET /lookup: now that it's reachable from a user-typed "go to any ID"
// search box (not just trusted internal call sites), an unauthenticated ID
// guessing/enumeration script hitting it repeatedly should be slowed down —
// but a person legitimately pasting several links in a session shouldn't be,
// so this is far more generous than strictRateLimiter.
export const lookupRateLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 60,
  message: "Too many lookup requests, please try again later",
});

// ── Activity deduplicator ─────────────────────────────────────────────────────
// Rejects identical activities submitted back-to-back within a short window.
// Catches double-clicks and accidental resubmissions without touching the DB.
// Key: sha256 of actorId + type + objectType + substantive content + to.

const dedupStore = new Map(); // hash → expiresAt

setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of dedupStore.entries()) {
    if (exp < now) dedupStore.delete(k);
  }
}, 60 * 1000);

export function activityDeduplicator(req, res, next) {
  if (process.env.RATE_LIMITING_ENABLED === "false") return next();
  if (req.method !== "POST" || !req.body) return next();

  const body = req.body;
  // Reactions are toggles: react -> un-react -> react the same emoji again
  // within the window is legitimate, but hashes identically to the first react
  // and would be rejected as a duplicate. The React handler is idempotent (one
  // reaction per user) and the client guards double-taps, so skip dedup here.
  if ((body.type || "") === "React") return next();
  const actorId = req.user?.id || body.actorId || "";
  const type    = body.type || "";
  const objType = body.objectType || "";
  const to      = body.to || "";
  // Target/object identity. Target-based activities (Delete, Add, Remove, ...)
  // carry no `object`, so without this every Delete hashes identically and you
  // can't delete two posts in a row (#52). Covers `target`, a string `object`,
  // and an object with an `id`.
  const targetId =
    body.target ||
    (typeof body.object === "string" ? body.object : body.object?.id) ||
    "";
  const content =
    body.object?.source?.content ||
    body.object?.body             ||
    body.object?.emoji            ||
    body.object?.name             ||
    JSON.stringify(body.object ?? "");

  const hash = crypto
    .createHash("sha256")
    .update(`${actorId}|${type}|${objType}|${to}|${targetId}|${content}`)
    .digest("hex");

  const now = Date.now();
  const WINDOW = 30_000; // 30 seconds

  if (dedupStore.has(hash) && dedupStore.get(hash) > now) {
    return res.status(409).json({ error: "Duplicate activity" });
  }

  dedupStore.set(hash, now + WINDOW);
  // A *failed* activity must not hold the dedup slot, or a corrected retry gets
  // wrongly rejected as a duplicate — e.g. create-group fails on bad coords, you
  // fix the location, and the resubmit is blocked (#53). Only successful
  // submissions should reserve the window; release the slot on any error.
  res.on("finish", () => {
    if (res.statusCode >= 400) dedupStore.delete(hash);
  });
  next();
}
