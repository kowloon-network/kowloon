// /routes/index.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import sanitizeQuery from "./middleware/sanitizeQuery.js";
import { moderateRateLimiter } from "./middleware/rateLimiter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const router = express.Router({ mergeParams: true });

// Record mounted subrouters for listing later
const mounted = [];

// --- parse JSON early -------------------------------------------------------
const JSON_LIMIT = process.env.JSON_LIMIT || "2mb";
const jsonTypes = [
  "application/json",
  "application/activity+json",
  "application/ld+json",
  "text/json",
  "text/activity+json",
];
router.use(
  express.json({
    limit: JSON_LIMIT,
    // Exact received bytes for HTTP-signature Digest verification.
    verify: (req, _res, buf) => { req.rawBody = buf; },
    type: (req) => {
      const ct = (req.headers["content-type"] || "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (!ct) return false;
      if (jsonTypes.includes(ct)) return true;
      if (ct.endsWith("+json")) return true;
      return false;
    },
  })
);
router.use(express.urlencoded({ extended: false, limit: JSON_LIMIT }));

// SECURITY: strip Mongo operator objects from the query string (?a[$ne]=x).
// See routes/middleware/sanitizeQuery.js for why this instead of mongoose's
// sanitizeFilter.
router.use(sanitizeQuery);

// --- request logging ---------------------------------------------------------
const API_LOG =
  /^(1|true|yes)$/i.test(process.env.API_LOG || "") ||
  process.env.NODE_ENV === "development";

router.use((req, _res, next) => {
  if (API_LOG) {
    const url = req.originalUrl || req.url || "";
    const [pathname, qs] = url.split("?", 2);
    console.log(`API ${req.method} ${pathname}${qs ? `?${qs}` : ""}`);
  }
  next();
});

// --- SPA deep-link guard -----------------------------------------------------
// A browser navigating directly to — or hard-refreshing — a frontend route whose
// path is ALSO an API endpoint (/circles, /groups, /profile, /users/:id/posts,
// /admin/*, …) must get the SPA shell, not raw API JSON. These path segments are
// shared between the SPA (browser) and the API (programmatic); we split on the
// Accept header, exactly as the per-route wantsHTML guards on posts/users/etc do,
// but centralized so EVERY SPA route (incl. sub-routes) is deep-linkable.
//
// Only browser navigations (Accept: text/html) under a known SPA segment defer to
// the SPA fallback (app.get('*') in index.js) via next('router'). ActivityPub and
// programmatic callers (application/activity+json, application/ld+json, or */*
// without text/html) fall through to the API unchanged, and ?rss is never
// hijacked so feeds keep working. botDetect.js still handles crawlers upstream.
const SPA_SEGMENTS = new Set([
  "circles", "groups", "users", "posts", "pages",
  "profile", "search", "notifications", "servers", "discover", "admin",
]);
function navWantsHTML(req) {
  const accept = req.headers.accept || "";
  if (accept.includes("application/activity+json")) return false;
  if (accept.includes("application/ld+json")) return false;
  return accept.includes("text/html");
}
router.use((req, _res, next) => {
  if (req.method !== "GET") return next();
  if ("rss" in req.query) return next();
  if (!navWantsHTML(req)) return next();
  const seg = req.path.split("/")[1] || "";
  if (SPA_SEGMENTS.has(seg)) return next("router");
  next();
});

// --- per-endpoint rate limits -------------------------------------------------
// Expensive/abusable endpoints that had no limiter. Applied here at the mount
// point (rather than inside each router) so those handlers stay untouched.
// Each gets its own limiter instance = its own counter. Placed after the SPA
// guard so browser page loads of /search etc. aren't counted. Inbox is
// deliberately NOT here (federation peers share IPs; it has its own limiter).
{
  const onlyMethod = (method, limiter) => (req, res, next) =>
    req.method === method ? limiter(req, res, next) : next();
  router.post(["/files", "/files/upload"], moderateRateLimiter("Too many uploads, please try again later"));
  router.use("/preview", onlyMethod("GET", moderateRateLimiter("Too many preview requests, please try again later")));
  router.use("/search", onlyMethod("GET", moderateRateLimiter("Too many search requests, please try again later")));
  router.post("/oauth/exchange", moderateRateLimiter("Too many requests, please try again later"));
  router.use("/invites", moderateRateLimiter("Too many invite requests, please try again later"));
}

// ---------------------------------------------------------------------------
// dynamic route mounting
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

const routesRoot = __dirname;
const entries = fs.readdirSync(routesRoot, { withFileTypes: true });

for (const dirent of entries) {
  if (!dirent.isDirectory()) continue;
  const name = dirent.name;
  if (name === "middleware" || name === "utils") {
    console.log(`routes: skip ${name} (utility)`);
    continue;
  }
  const indexJs = path.join(routesRoot, name, "index.js");
  if (!isFile(indexJs)) {
    console.log(`routes: skip ${name} (no index.js)`);
    continue;
  }
  // Special mount paths
  let mountPath;
  if (name === "home") {
    mountPath = "/";
  } else if (name === "well-known") {
    mountPath = "/.well-known";
  } else if (name === "config") {
    mountPath = "/config.json";
  } else {
    mountPath = `/${name}`;
  }
  try {
    const mod = await import(pathToFileURL(indexJs).href);
    const subrouter = mod.default || mod.router || mod;
    if (typeof subrouter !== "function") {
      console.warn(`routes: skip ${name} (default export is not a router)`);
      continue;
    }
    router.use(mountPath, subrouter);
    mounted.push({ mountPath, subrouter }); // record for listing
    console.log(`routes: mounted ${mountPath}`);
  } catch (e) {
    console.error(`routes: failed to mount ${name}:`, e.message);
  }
}

// ---------------------------------------------------------------------------
// Route listing utilities (no regex parsing of layer.regexp)

function joinPaths(a = "", b = "") {
  const s = `${a}${b}`;
  const n = s.replace(/\/+/g, "/");
  return n !== "/" ? n.replace(/\/$/, "") : "/";
}

function addRoute(out, seen, methods, path) {
  const keyBase = `${path}`;
  for (const m of methods) {
    const key = `${m} ${keyBase}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ methods: [m], path });
  }
}

function collectFromRouter(prefix, rtr, out, seen) {
  const stack = rtr && rtr.stack;
  if (!Array.isArray(stack)) return;

  for (const layer of stack) {
    if (layer && layer.route) {
      const rawPath = layer.route.path; // string or array
      const methods = Object.keys(layer.route.methods || {}).map((m) =>
        m.toUpperCase()
      );

      if (Array.isArray(rawPath)) {
        for (const p of rawPath) {
          addRoute(out, seen, methods, joinPaths(prefix, p));
        }
      } else {
        addRoute(out, seen, methods, joinPaths(prefix, rawPath));
      }
    } else if (
      layer &&
      layer.name === "router" &&
      layer.handle &&
      layer.handle.stack
    ) {
      // nested router; recurse with same prefix (child paths are relative)
      collectFromRouter(prefix, layer.handle, out, seen);
    }
  }
}

function listAllRoutes() {
  const out = [];
  const seen = new Set();

  for (const { mountPath, subrouter } of mounted) {
    collectFromRouter(mountPath === "/" ? "" : mountPath, subrouter, out, seen);
  }

  // Sort for readability
  out.sort(
    (a, b) =>
      a.path.localeCompare(b.path) || a.methods[0].localeCompare(b.methods[0])
  );
  return out;
}

// GET /__routes -> JSON list of all routes (skip listing __routes itself)
router.get("/__routes", (_req, res) => {
  const routes = listAllRoutes().filter((r) => r.path !== "/__routes");
  res.json({ total: routes.length, routes });
});

// Note: /inbox is now auto-mounted from routes/inbox/index.js directory

// Optional: log at boot
if (process.env.ROUTE_DEBUG) {
  const routes = listAllRoutes();
  console.log(`Loaded ${routes.length} routes:`);
  for (const r of routes) console.log(`${r.methods[0].padEnd(6)} ${r.path}`);
}

export default router;
