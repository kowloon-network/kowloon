// #methods/auth/verifyS2S.js
import crypto from "crypto";
import getSettings from "#methods/settings/get.js";

/**
 * Verify HMAC S2S headers:
 *  X-Client-Id: <peer domain>
 *  X-Timestamp: ms since epoch
 *  X-Signature: HMAC-SHA256 hex of `${METHOD}\n${PATH}\n${TIMESTAMP}\n${SHA256(body)}`
 *
 * @param {import('express').Request} req
 * @param {(clientId:string)=>Promise<string|null>} [getPeerSecret] optional override
 * @returns {Promise<{ clientId: string }|null>}
 */
export default async function verifyS2S(req, getPeerSecret) {
  const clientId = req.get("X-Client-Id");
  const timestamp = req.get("X-Timestamp");
  const signature = req.get("X-Signature");

  if (!clientId || !timestamp || !signature) return null;

  // small replay window (5 minutes)
  const skewMs = 5 * 60 * 1000;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > skewMs) return null;

  // normalize inputs for the signature
  const method = req.method.toUpperCase();
  // strip querystring; keep only path
  const path = req.originalUrl.split("?")[0];

  const rawBody = req.rawBody ?? ""; // add raw-body middleware below
  const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");
  const toSign = `${method}\n${path}\n${timestamp}\n${bodyHash}`;

  // look up secret
  let secret;
  if (getPeerSecret) {
    secret = await getPeerSecret(clientId);
  } else {
    // default: read from settings; you can swap for a DB lookup
    const settings = await getSettings();
    secret = settings?.peers?.[clientId]?.secret || null;
  }
  if (!secret) return null;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(toSign)
    .digest("hex");

  // timing-safe compare
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  return { clientId };
}
