// #methods/auth/requireUser.js
import verifyUserJwt from "./verifyUserJwt.js"; // uses jose + settings.publicKey/JWKS  [oai_citation:2‡verifyUserJwt.js](file-service://file-8gZMHNcxmxqGfksDDkbJPc)

/**
 * Verify a user Bearer token and return the payload.user.
 * @param {import('express').Request} req
 * @param {Object} opts
 * @param {string} opts.expectedAudience   // usually `https://${process.env.DOMAIN}`
 * @param {string} [opts.expectedIssuer]   // if omitted, inferred from token 'iss' in a safe way
 */
export default async function requireUser(
  req,
  { expectedAudience, expectedIssuer } = {}
) {
  const authz = req.header("Authorization") || "";
  if (!authz.startsWith("Bearer ")) {
    const e = new Error("Missing Bearer token");
    e.status = 401;
    throw e;
  }
  const token = authz.slice(7).trim();

  // decode only to read iss if issuer not provided (do not trust without verify)
  let iss = expectedIssuer;
  if (!iss) {
    // cheap parse, still untrusted: we only use it to choose JWKS vs local key
    const [, payloadB64] = token.split(".");
    const payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8")
    );
    iss = payload.iss;
  }

  const payload = await verifyUserJwt(token, {
    expectedIssuer: iss,
    expectedAudience,
  });

  if (!payload?.user?.id) {
    const e = new Error("Invalid user token");
    e.status = 401;
    throw e;
  }
  return payload.user; // e.g. { id, username, ... }
}
