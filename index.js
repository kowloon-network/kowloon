// /index.js
import "dotenv/config";
// Must come before everything else -- @sentry/node installs global handlers
// for uncaught exceptions and unhandled rejections at init, so anything
// imported ahead of it could throw unreported. No-op without SENTRY_DSN.
import "#methods/utils/errorReporting.js";
import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import nocache from "nocache";
import http from "http";

import Kowloon, { attachMethodDomains } from "#kowloon";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Connect DB & load settings BEFORE loading method domains, to avoid buffering timeouts.
import initKowloon from "#methods/utils/init.js";

// 1) Validate required config in production
if (process.env.NODE_ENV === "production" && !process.env.DOMAIN) {
  console.error(
    "ERROR: DOMAIN is not set. Run the Kowloon installer first, or set DOMAIN in your .env file."
  );
  process.exit(1);
}

// 2) Connect DB + load settings/admin
await initKowloon(Kowloon, {
  domain: process.env.DOMAIN || undefined,
  siteTitle: process.env.SITE_TITLE || "Kowloon",
  adminEmail: process.env.ADMIN_EMAIL || undefined,
  adminUsername: process.env.ADMIN_USERNAME || undefined,
  adminDisplayName: process.env.ADMIN_DISPLAY_NAME || undefined,
  adminPassword: process.env.ADMIN_PASSWORD || undefined,
  smtpHost: process.env.SMTP_HOST || undefined,
  smtpPort: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined,
  smtpUser: process.env.SMTP_USER || undefined,
  smtpPass: process.env.SMTP_PASS || undefined,
});

// 3) Now load methods (safe: DB is up)
// await attachMethodDomains(Kowloon);

// 4) Build Express
const app = express();

// Allow the server's own origin by default. Admins running the frontend on a
// separate domain can set CORS_ORIGIN (comma-separated) to add extra origins.
// Federation (server-to-server) and native clients are unaffected by CORS.
const _corsDomain = process.env.DOMAIN;
const _corsExtra = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean)
  : [];
const _corsAllowed = new Set([
  ...(process.env.NODE_ENV !== "production" ? ["http://localhost:5173", "http://localhost:3000"] : []),
  ...(_corsDomain ? [`https://${_corsDomain}`, `http://${_corsDomain}`] : []),
  ..._corsExtra,
]);
app.use(cors({
  origin: (origin, cb) => {
    // Non-browser requests (native clients, federation) have no origin — always allow.
    if (!origin) return cb(null, true);
    cb(null, _corsAllowed.has(origin) ? origin : false);
  },
  credentials: true,
}));

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(cookieParser());
app.use(nocache());

// Make Kowloon available to routes
app.locals.Kowloon = Kowloon;
app.use((req, _res, next) => {
  req.Kowloon = Kowloon;
  next();
});

// 5) SEO middleware — intercept crawler/scraper requests before API routes
const { default: botMiddleware } = await import("#methods/seo/botDetect.js");
app.use(botMiddleware);

// 5a) robots.txt + sitemap.xml
const { generateRobots } = await import("#methods/seo/robots.js");
const { generateSitemap } = await import("#methods/seo/sitemap.js");
app.get("/robots.txt", (req, res) => {
  res.set("Content-Type", "text/plain").send(generateRobots(req));
});
app.get("/sitemap.xml", async (req, res) => {
  const xml = await generateSitemap(req);
  res.set("Content-Type", "application/xml").send(xml);
});

// 6) Import and mount your existing aggregate router AFTER DB + methods are ready
const routes = (await import("#routes/index.js")).default;
app.use("/", routes);

// Sample media — dev/seed icons served from the repo's sample-media folder.
// Mounted unconditionally (not gated on SERVE_FRONTEND) so seeded user/circle/
// group icon URLs keep resolving in any environment.
const sampleMediaDir = join(__dirname, "..", "sample-media");
if (existsSync(sampleMediaDir)) {
  const { default: serveStatic } = await import("serve-static");
  app.use("/sample-icons", serveStatic(sampleMediaDir, { maxAge: "1y" }));
}

// Built-in placeholder icons (user.svg, circle.svg, group.svg) — referenced by
// schema defaults so a brand-new User/Circle/Group has a valid icon URL even
// before any custom upload. Mounted unconditionally for the same reason as
// sample-icons above.
const imagesDir = join(__dirname, "public", "images");
if (existsSync(imagesDir)) {
  const { default: serveStatic } = await import("serve-static");
  app.use("/images", serveStatic(imagesDir, { maxAge: "1y" }));
}

// 7) Serve built frontend (if present) — after API routes so they take priority
const publicDir = join(__dirname, "public");
// Gate on index.html specifically: public/ also exists (for /images placeholder
// icons) in dev where the frontend isn't built, and serving an absent index.html
// would 404 every SPA route.
if (existsSync(join(publicDir, "index.html")) && process.env.SERVE_FRONTEND !== "false") {
  const { default: serveStatic } = await import("serve-static");
  // Lets the `/` route fall through to the SPA for browser requests instead of
  // returning the server-info JSON (see routes/home/index.js).
  app.locals.frontendEnabled = true;
  app.use(serveStatic(publicDir, { maxAge: "1y", immutable: true, index: false }));

  // SPA fallback. For content routes we inject per-item <head> meta (Open Graph,
  // Twitter, and kowloon:id/type) into the served index.html, so EVERY visitor
  // and scraper — not just the whitelisted crawlers botDetect handles — gets a
  // proper preview card and can read the object's canonical Kowloon ID straight
  // off the page. Everything else serves the static shell unchanged.
  const { fetchMeta } = await import("#methods/seo/meta.js");
  const { renderHeadTags } = await import("#methods/seo/shell.js");
  const indexHtmlPath = join(publicDir, "index.html");
  let indexHtmlCache = null;
  const readIndexHtml = () => (indexHtmlCache ??= readFileSync(indexHtmlPath, "utf8"));
  const CONTENT_ROUTE = /^\/(posts|users|groups|pages)\/.+/;

  function injectHeadTags(html, tags) {
    // Strip the build's default title/description/OG/Twitter so the per-item
    // tags win (scrapers take the first occurrence), then insert before </head>.
    return html
      .replace(/<title>[\s\S]*?<\/title>/i, "")
      .replace(/<meta\s+name=["']description["'][^>]*>/gi, "")
      .replace(/<link\s+rel=["']canonical["'][^>]*>/gi, "")
      .replace(/<meta\s+property=["']og:[^"']*["'][^>]*>/gi, "")
      .replace(/<meta\s+name=["']twitter:[^"']*["'][^>]*>/gi, "")
      .replace(/<\/head>/i, `${tags}\n</head>`);
  }

  app.get("*", async (req, res) => {
    try {
      if (CONTENT_ROUTE.test(req.path)) {
        const meta = await fetchMeta(req.path, req);
        return res.type("html").send(injectHeadTags(readIndexHtml(), renderHeadTags(meta)));
      }
    } catch {
      // Any failure → serve the static shell so navigation never breaks.
    }
    res.sendFile(indexHtmlPath);
  });
}

// Health checks live at routes/health/index.js, auto-mounted at /health —
// CORS-open so the setup wizard can poll cross-origin, returns 503 on a
// disconnected DB. (Previously duplicated here as /health + /__health; both
// were dead code — the auto-mounted router always wins route resolution for
// /health, and /__health had no caller anywhere in the codebase or infra.)

// Start HTTP
const port = Number(process.env.PORT || 3000);
http.createServer(app).listen(port, "0.0.0.0", () => {
  console.log(`HTTP listening on :${port}`);
});

// Start outbox worker for federation (outbound delivery)
try {
  const { startOutboxWorker } = await import(
    "#methods/federation/outboxWorker.js"
  );
  const workerInterval = Number(process.env.OUTBOX_WORKER_INTERVAL || 5000);
  startOutboxWorker(workerInterval);
} catch (err) {
  console.error("Failed to start outbox worker:", err.message);
}

// Start poll worker for federation (inbound pull from remote servers)
try {
  const { startPollWorker } = await import(
    "#methods/federation/pollWorker.js"
  );
  const pollInterval = Number(process.env.POLL_WORKER_INTERVAL || 30_000);
  startPollWorker(pollInterval);
} catch (err) {
  console.error("Failed to start poll worker:", err.message);
}

// Start nightly GC worker (hard-delete aged soft-deleted objects, orphaned FeedItems, files)
try {
  const { startGCWorker } = await import("#methods/gc/index.js");
  startGCWorker();
} catch (err) {
  console.error("Failed to start GC worker:", err.message);
}

export default Kowloon;
