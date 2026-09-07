// #methods/oauth/tokens.js
// Token minting/verification helpers for the cross-server OAuth flow.
// Access tokens reuse the exact signing shape methods/generate/token.js
// already uses (RS256, same kid derivation) so they verify via the same
// JWKS this server publishes at /.well-known/jwks.json.
import crypto from "crypto";
import { SignJWT, importPKCS8 } from "jose";
import getSettings from "#methods/settings/get.js";
import { OAuthRefreshToken, Circle, User } from "#schema";

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1h
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d

async function getSigningKey(settings) {
  const pk = await importPKCS8(settings.privateKey.replace(/\\n/g, "\n").trim(), "RS256");
  const kid = crypto.createHash("sha256").update(settings.publicKey).digest("base64url");
  return { pk, kid };
}

// Access token: proves "this user, on their home server, authorized this
// specific foreign domain to act as them." Verified by the foreign domain
// via this server's JWKS (sub/iss/aud/exp all checked — see
// methods/auth/verifyUserJwt.js). scope: "visiting" is read by this SAME
// server's own /outbox route (routes/outbox/post.js) when the proxied
// activity finally lands back here under real local authority — it caps
// what a cross-server session can do to the interaction-shaped actions the
// consent screen actually described (reply/react/post), not full account
// access. Nested inside `user`, not a sibling claim, so it survives
// unchanged through routes/utils/route.js's attachUserFromToken, which sets
// req.user = payload.user verbatim.
export async function mintAccessToken({ user, clientDomain }) {
  const settings = await getSettings();
  const { pk, kid } = await getSigningKey(settings);

  const token = await new SignJWT({
    user: {
      id: user.id,
      username: user.username,
      profile: user.profile,
      scope: "visiting",
      // Carried so /outbox can check "has this user blocked the domain this
      // token was issued to" on every request, not just at grant time —
      // req.user only ever sees payload.user (attachUserFromToken), never
      // the token's own `aud` claim, so this has to live here too.
      clientDomain,
    },
  })
    .setProtectedHeader({ alg: "RS256", kid })
    .setSubject(user.id)
    .setIssuer(`https://${settings.domain}`)
    .setAudience(`https://${clientDomain}`)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(pk);

  return { token, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

// Visiting session token: this server's OWN locally-signed session token,
// handed to the browser once a foreign identity's OAuth exchange completes.
// Verified the exact same way every other session token is (routes/utils/
// route.js's attachUserFromToken) — it never carries the real cross-server
// access/refresh token, only an opaque sessionId used to look those up
// server-side (schema/VisitingIdentity.js).
export async function mintVisitingSessionToken({ sessionId, user }) {
  const settings = await getSettings();
  const { pk, kid } = await getSigningKey(settings);

  // visiting/sessionId live INSIDE `user`, not as sibling top-level claims —
  // routes/utils/route.js's attachUserFromToken sets req.user = payload.user
  // verbatim and never looks at sibling claims, so this is what makes
  // req.user.visiting/req.user.sessionId reach the outbox route unchanged.
  const token = await new SignJWT({
    user: {
      id: user.id,
      username: user.username,
      profile: user.profile,
      visiting: true,
      sessionId,
    },
  })
    .setProtectedHeader({ alg: "RS256", kid })
    .setSubject(user.id)
    .setIssuer(`https://${settings.domain}`)
    .sign(pk);

  return token;
}

function hashToken(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export async function issueRefreshToken({ userId, clientDomain }) {
  const raw = crypto.randomBytes(32).toString("hex");
  await OAuthRefreshToken.create({
    tokenHash: hashToken(raw),
    userId,
    clientDomain,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  });
  return raw;
}

// Validates + revokes a refresh token (rotation — single use). Returns
// { userId, clientDomain } on success, null if invalid/expired/revoked.
export async function consumeRefreshToken({ rawToken, clientDomain }) {
  if (!rawToken) return null;
  const tokenHash = hashToken(rawToken);
  const row = await OAuthRefreshToken.findOne({ tokenHash, clientDomain, revokedAt: null });
  if (!row) return null;
  if (row.expiresAt <= new Date()) return null;
  row.revokedAt = new Date();
  await row.save();
  return { userId: row.userId, clientDomain: row.clientDomain };
}

// Active (non-revoked, non-expired) grants a user has given out, one row
// per foreign domain (most recent if a domain somehow has more than one —
// rotation should always leave at most one live row per domain, but this
// doesn't assume that invariant holds).
export async function listActiveGrants({ userId }) {
  const rows = await OAuthRefreshToken.find({
    userId,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  })
    .sort({ createdAt: -1 })
    .lean();

  const byDomain = new Map();
  for (const row of rows) {
    if (!byDomain.has(row.clientDomain)) {
      byDomain.set(row.clientDomain, { clientDomain: row.clientDomain, grantedAt: row.createdAt, expiresAt: row.expiresAt });
    }
  }
  return [...byDomain.values()];
}

// Revokes every live refresh token a user has granted to a given domain —
// stops future renewal. Any access token already issued still runs out
// naturally within ACCESS_TOKEN_TTL_SECONDS; isDomainBlockedByUser below is
// what gives an actual block immediate effect, not this alone.
export async function revokeGrantsForDomain({ userId, clientDomain }) {
  const res = await OAuthRefreshToken.updateMany(
    { userId, clientDomain, revokedAt: null },
    { revokedAt: new Date() }
  );
  return res.modifiedCount || 0;
}

// Checked on every /outbox request from a scope:"visiting" access token
// (routes/outbox/post.js) — catches a domain blocked AFTER the token was
// issued, without waiting for it to expire. Bare "@domain" is the same
// server-block shorthand ServerMoreMenu.jsx already writes via addToCircle.
export async function isDomainBlockedByUser(userId, domain) {
  if (!userId || !domain) return false;
  const owner = await User.findOne({ id: userId }).select("circles.blocked").lean();
  if (!owner?.circles?.blocked) return false;
  const hit = await Circle.findOne({
    id: owner.circles.blocked,
    "members.id": `@${domain}`,
  })
    .select("_id")
    .lean();
  return !!hit;
}

export const ACCESS_TOKEN_TTL = ACCESS_TOKEN_TTL_SECONDS;
