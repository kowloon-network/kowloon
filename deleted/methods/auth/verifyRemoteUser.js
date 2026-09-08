// /methods/auth/verifyRemoteUser.js
import * as jose from "jose";
import logger from "#methods/utils/logger.js";

async function fetchRemoteJWKS(issuer) {
  const jwksUrl = new URL("/.well-known/jwks.json", issuer).toString();
  return jose.createRemoteJWKSet(new URL(jwksUrl));
}

/**
 * Verify a remote user's JWT (and optional DPoP).
 * @param {object} opts
 * @param {string} opts.authz  - "Bearer <jwt>"
 * @param {string} [opts.dpop] - DPoP header value (optional)
 * @param {string} [opts.expectedAud] - your server origin (e.g., https://your.dom)
 */
export default async function verifyRemoteUser({ authz, dpop, expectedAud }) {
  if (!authz?.startsWith("Bearer "))
    return { ok: false, error: "Missing Bearer token" };
  const token = authz.slice("Bearer ".length);

  let decoded;
  try {
    decoded = jose.decodeJwt(token);
  } catch {
    return { ok: false, error: "Malformed JWT" };
  }

  const iss = decoded.iss;
  const sub = decoded.sub;
  if (!iss || !sub) return { ok: false, error: "JWT missing iss/sub" };

  try {
    const JWKS = await fetchRemoteJWKS(iss);
    const { payload } = await jose.jwtVerify(token, JWKS, {
      issuer: iss,
      audience: expectedAud, // optional but recommended
    });

    // DPoP (optional): if provided, validate it and enforce cnf (proof-of-possession)
    if (dpop) {
      try {
        await jose.jwtVerify(dpop, JWKS); // placeholder; in practice you'd validate the JWK thumbprint against token.cnf
      } catch (e) {
        return { ok: false, error: `Invalid DPoP: ${e.message}` };
      }
    }

    return {
      ok: true,
      user: { id: sub, issuer: iss, scope: payload.scope },
      token: payload,
    };
  } catch (e) {
    logger.warn("verifyRemoteUser failed", { error: e.message, iss });
    return { ok: false, error: e.message };
  }
}
