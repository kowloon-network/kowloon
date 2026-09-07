// #methods/oauth/tokens.js
// Token minting/verification helpers for the cross-server OAuth flow.
// Access tokens reuse the exact signing shape methods/generate/token.js
// already uses (RS256, same kid derivation) so they verify via the same
// JWKS this server publishes at /.well-known/jwks.json.
import crypto from "crypto";
import { SignJWT, importPKCS8 } from "jose";
import getSettings from "#methods/settings/get.js";
import { OAuthRefreshToken } from "#schema";

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
// methods/auth/verifyUserJwt.js).
export async function mintAccessToken({ user, clientDomain }) {
  const settings = await getSettings();
  const { pk, kid } = await getSigningKey(settings);

  const token = await new SignJWT({
    user: {
      id: user.id,
      username: user.username,
      profile: user.profile,
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

export const ACCESS_TOKEN_TTL = ACCESS_TOKEN_TTL_SECONDS;
