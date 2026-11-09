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
//
// Also enforces User.tokensValidAfter (2026-11-09): a password change or
// reset stamps it, and any token issued before that instant (or with no
// `iat` at all -- every token minted before iat was added) stops working,
// so changing your password really does sign out your other devices.
//
// SECURITY (2026-11-09): no longer fails OPEN. A DB error used to return
// true, silently disabling revocation. It now throws AuthUnavailable, which
// the wrapper turns into a 503 -- deliberately NOT a 401, because clients
// (mobile's onUnauthorized) sign the user out on 401, and a Mongo blip must
// not log everyone out either.
class AuthUnavailable extends Error {}
async function isAccountUsable(id, iat) {
  try {
    const { User } = await import("#schema");
    const row = await User.findOne({ id })
      .select("active tokensValidAfter")
      .lean();
    if (!row || row.active === false) return false;
    if (row.tokensValidAfter) {
      const issuedMs = typeof iat === "number" ? iat * 1000 : 0;
      if (issuedMs < new Date(row.tokensValidAfter).getTime()) return false;
    }
    return true;
  } catch (e) {
    throw new AuthUnavailable(e?.message || "auth lookup failed");
  }
}

// Domain part of a Kowloon id: "@user@domain" -> "domain", "@domain" -> "domain".
function domainOfId(id) {
  if (typeof id !== "string") return null;
  const at = id.lastIndexOf("@");
  return at >= 0 ? id.slice(at + 1).toLowerCase() : null;
}

// SECURITY (2026-11-09): a visiting-session token (minted by
// routes/oauth/exchange.js for a FOREIGN user browsing this server) is only
// valid while its server-side VisitingIdentity row exists, and must never
// name a LOCAL account -- an exchange that claimed a local id is exactly how
// a forged cross-server login impersonated local admins.
async function isVisitingSessionValid(u, localDomain) {
  try {
    if (!u?.sessionId || !u?.id) return false;
    const d = domainOfId(u.id);
    if (!d || d === localDomain) return false;
    const { VisitingIdentity } = await import("#schema");
    const row = await VisitingIdentity.findOne({
      sessionId: u.sessionId,
      userId: u.id,
    })
      .select("_id")
      .lean();
    return !!row;
  } catch (e) {
    throw new AuthUnavailable(e?.message || "auth lookup failed");
  }
}

// importSPKI re-parsed the PEM on every authenticated request. Cache the
// KeyObject by PEM string; tiny bound (normally 1 entry, a few during a key
// rotation).
const SPKI_CACHE_MAX = 4;
const spkiCache = new Map();
async function getVerifyKey(pem) {
  let key = spkiCache.get(pem);
  if (!key) {
    key = importSPKI(pem, "RS256");
    spkiCache.set(pem, key);
    while (spkiCache.size > SPKI_CACHE_MAX) spkiCache.delete(spkiCache.keys().next().value);
    key.catch(() => spkiCache.delete(pem)); // don't cache a bad PEM's failure
  }
  return key;
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
    const publicKey = await getVerifyKey(pub);
    const { payload } = await jwtVerify(token, publicKey, {
      algorithms: ["RS256"],
      ...(issuer ? { issuer } : {}),
    });

    const id =
      payload?.user?.id || payload?.id || payload?.sub || payload?.actorId;
    if (!id) return false;
    const localDomain = String(issuerDomain || "").toLowerCase();
    const u = payload.user || { id };

    if (u.visiting) {
      // Foreign identity browsing this server (see isVisitingSessionValid).
      if (await isVisitingSessionValid(u, localDomain)) {
        req.user = u;
        if (DEV) console.log(`ROUTE auth: attached (visiting) → ${u.id}`);
        return true;
      }
      if (DEV) console.warn(`ROUTE auth: visiting session rejected → ${id}`);
      return false;
    }

    // Every other token this server signs is for one of ITS OWN accounts
    // (normal sessions, and scope:"visiting" access tokens issued to a
    // foreign server for a local user). Refuse anything naming another domain.
    if (domainOfId(id) !== localDomain) {
      if (DEV) console.warn(`ROUTE auth: non-local id in local token → ${id}`);
      return false;
    }

    if (await isAccountUsable(id, payload.iat)) {
      req.user = u;
      if (DEV) console.log(`ROUTE auth: attached (RS256) → ${req.user.id}`);
      return true;
    }
    if (DEV) console.warn(`ROUTE auth: token valid but account revoked → ${id}`);
  } catch (e) {
    if (e instanceof AuthUnavailable) throw e;
    if (DEV) console.warn("ROUTE auth: RS256 verify failed:", e.message);
  }

  // SECURITY (2026-11-09): the HS256 fallback that verified tokens against
  // JWT_SECRET was removed. Nothing in this codebase ever signed such
  // tokens, so it only ever served as a way to forge one -- and
  // .env.example shipped a guessable default secret.
  return false;
}

// Shared with guards that don't use route() (routes/admin/index.js), so every
// authenticated surface applies the same revocation + cross-domain rules.
// Returns req.user or null; throws AuthUnavailable on a DB error.
export async function authenticateRequest(req) {
  await attachUserFromToken(req);
  return req.user?.id ? req.user : null;
}
export { AuthUnavailable };

export default function route(handler, options = {}) {
  const {
    allowUnauth = undefined,
    // SECURITY (2026-10-28): defaulted to `true`, which let any unauthenticated
    // POST whose body looked like a Create→User activity through the auth
    // check on EVERY route using this wrapper. Account creation belongs to
    // /register (invite-gated) and /admin/users (admin-only). Opt in per-route
    // if some future route genuinely needs it.
    allowUnauthCreateUser = false,
    // SECURITY (2026-11-09): cross-server tokens are refused everywhere by
    // default. Two kinds exist:
    //  - user.scope === "visiting": an access token THIS server issued to a
    //    foreign server so it can act for one of our users. Only POST /outbox
    //    may accept it (it enforces its own activity allowlist there).
    //  - user.visiting === true: a session for a FOREIGN user browsing here.
    //    Read-only (safe methods) plus routes that opt in.
    // Before this, scope was checked on four routes only, so such a token was
    // a full session on every other route (notifications, private circles,
    // file deletion, push registration...).
    allowVisiting = false,
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

    try {
      await attachUserFromToken(req);
    } catch (e) {
      if (e instanceof AuthUnavailable) {
        return res
          .status(503)
          .json({ error: "Temporarily unable to verify your session" });
      }
      throw e;
    }

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

    if (!allowVisiting && req.user) {
      const isAccessToken = req.user.scope === "visiting";
      const isVisitingWrite = req.user.visiting && !SAFE_METHODS.has(method);
      if (isAccessToken || isVisitingWrite) {
        if (DEV) console.warn(`${tag}: 403 cross-server token refused`);
        return res
          .status(403)
          .json({ error: "This action isn't available for a visiting session" });
      }
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
      // Every route error ends up here and, outside DEV, was previously
      // invisible -- a 500 went to the client and nothing was recorded.
      // Report it to GlitchTip (no-op without SENTRY_DSN). Deliberately
      // sends only route/method/status, never body, headers or user id.
      try {
        const { reportError } = await import("#methods/utils/errorReporting.js");
        reportError(err, { route: label, method, path, status: 500 });
      } catch {
        /* reporting must never mask the original error */
      }
      res.status(500).json({ error: msg });
    }
  };
}
