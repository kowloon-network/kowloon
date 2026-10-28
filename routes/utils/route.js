// /routes/utils/route.js
// Route wrapper: unauthenticated GET/HEAD/OPTIONS allowed by default.
// Passes { query, params } to handlers (in addition to { req, body, user, set, setStatus }).
// Verifies RS256 JWTs using settings.publicKey and settings.domain as issuer.

import { jwtVerify, importSPKI } from "jose";

const DEV =
  process.env.NODE_ENV === "development" ||
  /^(1|true|yes)$/i.test(process.env.ROUTE_DEBUG || "");

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

function isCreateUserActivity(body) {
  if (!isObj(body)) return false;
  if (body.type !== "Create") return false;
  if (body.objectType === "User") return true;
  const ot = body?.object?.type;
  return typeof ot === "string" && /^(User|Person)$/i.test(ot);
}

function normalizePem(s) {
  return typeof s === "string" ? s.replace(/\\n/g, "\n").trim() : s;
}

function extractToken(req) {
  const hdrs = req?.headers || {};
  const auth = hdrs.authorization || hdrs.Authorization || "";
  let token = "";
  const m = auth.match(/^(?:Bearer|Token|JWT)\s+(.+)$/i);
  if (m && m[1]) token = m[1].trim();
  if (!token && auth && !/\s/.test(auth)) token = auth.trim();
  if (!token) {
    const alt =
      hdrs["x-auth-token"] ||
      hdrs["x-access-token"] ||
      hdrs["x-token"] ||
      hdrs["auth-token"] ||
      hdrs["x-jwt"];
    if (alt) token = String(alt).trim();
  }
  return token || "";
}

// Real session revocation: a deleted or deactivated account's existing JWTs
// (which never expire -- see methods/generate/token.js) must stop working on
// their very next request, not just whenever they'd naturally expire. No
// separate "tokensInvalidAfter" field needed -- the row being gone or
// flagged inactive IS the revocation signal. One cheap indexed lookup;
// attachUserFromToken runs exactly once per request (see the early-return
// above), so this isn't a hot-path concern.
async function isAccountUsable(id) {
  try {
    const { User } = await import("#schema");
    const row = await User.findOne({ id }).select("active").lean();
    return !!row && row.active !== false;
  } catch {
    // Fail open on an unexpected DB hiccup -- same posture as the rest of
    // this file, which never hard-fails auth on infra errors.
    return true;
  }
}

async function attachUserFromToken(req) {
  if (req.user && req.user.id) return true;
  const token = extractToken(req);
  if (!token) return false;

  try {
    const getSettingsMod = await import("#methods/settings/get.js");
    const getSettings = getSettingsMod?.default || getSettingsMod;
    const settings =
      typeof getSettings === "function" ? await getSettings() : {};
    const pub = normalizePem(settings?.publicKey || process.env.JWT_PUBLIC_KEY);
    const issuerDomain =
      settings?.domain || process.env.KOWLOON_DOMAIN || process.env.DOMAIN;
    const issuer = issuerDomain ? `https://${issuerDomain}` : undefined;

    if (!pub) throw new Error("Missing public key for JWT verification");
    const publicKey = await importSPKI(pub, "RS256");
    const { payload } = await jwtVerify(token, publicKey, {
      algorithms: ["RS256"],
      ...(issuer ? { issuer } : {}),
    });

    const id =
      payload?.user?.id || payload?.id || payload?.sub || payload?.actorId;
    if (id && (await isAccountUsable(id))) {
      req.user = payload.user ? payload.user : { id };
      if (DEV) console.log(`ROUTE auth: attached (RS256) → ${req.user.id}`);
      return true;
    }
    if (id && DEV) console.warn(`ROUTE auth: token valid but account revoked → ${id}`);
  } catch (e) {
    if (DEV) console.warn("ROUTE auth: RS256 verify failed:", e.message);
  }

  try {
    const secret = process.env.JWT_SECRET || process.env.JWT_KEY;
    if (secret) {
      const secretKey = new TextEncoder().encode(secret);
      const { payload } = await jwtVerify(token, secretKey);
      const id =
        payload?.user?.id || payload?.id || payload?.sub || payload?.actorId;
      if (id && (await isAccountUsable(id))) {
        req.user = payload.user ? payload.user : { id };
        if (DEV) console.log(`ROUTE auth: attached (HMAC) → ${req.user.id}`);
        return true;
      }
    }
  } catch {}

  return false;
}

export default function route(handler, options = {}) {
  const {
    allowUnauth = undefined,
    // SECURITY (2026-10-28): defaulted to `true`, which let any unauthenticated
    // POST whose body looked like a Create→User activity through the auth
    // check on EVERY route using this wrapper. Account creation belongs to
    // /register (invite-gated) and /admin/users (admin-only). Opt in per-route
    // if some future route genuinely needs it.
    allowUnauthCreateUser = false,
    label = "ROUTE",
  } = options;

  return async function routeWrapper(req, res) {
    const rid = Math.random().toString(36).slice(2, 8);
    const tag = `${label} ${rid}`;

    const method = (req?.method || "GET").toUpperCase();
    const path = req?.originalUrl || req?.url || "";
    const ip = req?.ip || req?.connection?.remoteAddress || "";

    // Ensure these are always defined for handlers
    const query = (req && req.query) || {};
    const params = (req && req.params) || {};
    const body = (req && req.body) || {};

    await attachUserFromToken(req);

    const defaultAllow = SAFE_METHODS.has(method);
    const allow =
      (allowUnauth !== undefined ? !!allowUnauth : defaultAllow) ||
      (allowUnauthCreateUser &&
        method === "POST" &&
        isCreateUserActivity(body));

    const out = {};
    const set = (k, v) => {
      if (k === "error" && !v) return;
      out[k] = v;
    };
    const setStatus = (code) => res.status(code);

    if (DEV) {
      console.log(`${tag}: enter`, {
        method,
        path,
        ip,
        user: req.user?.id || null,
        allowUnauth: allow,
        q: query,
        p: params,
      });
    }

    if (!req.user?.id && !allow) {
      if (DEV) console.warn(`${tag}: 401 Unauthorized (no req.user)`);
      return res.status(401).json({ error: "Unauthorized" });
    }

    try {
      await handler({
        req,
        query,
        params,
        body,
        user: req.user || null,
        set,
        setStatus,
      });
      if (!res.statusCode || res.statusCode < 100) res.status(200);
      if (DEV) console.log(`${tag}: exit ${res.statusCode}`);
      res.json(out);
    } catch (err) {
      const msg = err?.message || String(err);
      if (DEV) console.error(`${tag}: handler threw`, err?.stack || msg);
      res.status(500).json({ error: msg });
    }
  };
}
