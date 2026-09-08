// #methods/auth/signS2S.js
import crypto from "crypto";

/**
 * Create S2S signature headers for an outbound request.
 * Use the same string-to-sign format as verifyS2S.
 *
 * @param {Object} p
 * @param {"GET"|"POST"|"PUT"|"DELETE"|"PATCH"} p.method
 * @param {string} p.path      // absolute path, no origin, e.g. '/outbox/@bob@serverA.com'
 * @param {string|Buffer} [p.body=""]
 * @param {string} [p.serverId=process.env.DOMAIN]
 * @param {string} [p.secret=process.env.SERVER_SECRET]
 */
export default function signS2S({
  method,
  path,
  body = "",
  serverId = process.env.DOMAIN,
  secret = process.env.SERVER_SECRET,
}) {
  if (!serverId || !secret)
    throw new Error("Missing serverId or secret for S2S signing");

  const timestamp = Date.now().toString();
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  const toSign = `${method.toUpperCase()}\n${path}\n${timestamp}\n${bodyHash}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(toSign)
    .digest("hex");

  return {
    "X-Client-Id": serverId,
    "X-Timestamp": timestamp,
    "X-Signature": signature,
  };
}
