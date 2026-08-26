// /methods/federation/signHttpRequest.js
// Creates HTTP signature for outbound federation requests

import crypto from "crypto";
import { getSetting } from "#methods/settings/cache.js";
import log from "#methods/utils/logger.js";

/**
 * Get server signing credentials from settings cache — no DB lookup needed.
 * @returns {{ domain: string, privateKey: string, actorUrl: string } | null}
 */
function getServerSigningCredentials() {
  const domain = getSetting("domain") || process.env.DOMAIN;
  const privateKey = getSetting("privateKey") || process.env.PRIVATE_KEY;
  if (!domain || !privateKey) {
    log.error("Cannot sign: missing domain or privateKey in settings cache");
    return null;
  }
  return { domain, privateKey, actorUrl: `https://${domain}/users/@${domain}` };
}

/**
 * Build signing string from request components
 * @param {string} method - HTTP method (e.g., 'post')
 * @param {string} path - Request path (e.g., '/inbox')
 * @param {Object} headers - Headers to include in signature
 * @param {Array<string>} headersList - List of headers to sign
 * @returns {string} The signing string
 */
function buildSigningString(method, path, headers, headersList) {
  const lines = [];

  for (const h of headersList) {
    if (h === "(request-target)") {
      lines.push(`(request-target): ${method.toLowerCase()} ${path}`);
    } else {
      const val = headers[h.toLowerCase()];
      if (!val) {
        throw new Error(`Missing required header for signing: ${h}`);
      }
      lines.push(`${h.toLowerCase()}: ${val}`);
    }
  }

  return lines.join("\n");
}

/**
 * Create HTTP signature for a request
 * @param {Object} options
 * @param {string} options.method - HTTP method ('POST', 'GET', etc.)
 * @param {string} options.url - Full URL being requested
 * @param {Object} options.headers - Headers object (will be mutated)
 * @param {string|Object} options.body - Request body
 * @returns {Promise<Object>} Updated headers with Signature and Digest
 */
export default async function signHttpRequest({
  method,
  url,
  headers = {},
  body = "",
}) {
  // Get server signing credentials from settings (no DB lookup)
  const creds = getServerSigningCredentials();
  if (!creds) {
    throw new Error("Server signing credentials not available");
  }
  const { domain, privateKey: serverPrivateKey, actorUrl } = creds;

  // Parse URL
  const parsedUrl = new URL(url);
  const path = parsedUrl.pathname + parsedUrl.search;
  const host = parsedUrl.host;

  // Build body string if needed
  let bodyStr = "";
  if (body) {
    if (typeof body === "string") {
      bodyStr = body;
    } else if (Buffer.isBuffer(body)) {
      bodyStr = body.toString("utf8");
    } else if (typeof body === "object") {
      bodyStr = JSON.stringify(body);
    }
  }

  // Digest is a body-integrity check — meaningless (and unverifiable) for a
  // genuinely bodyless request. Omit it entirely rather than signing a
  // digest of "": Express's json() body-parser middleware normalizes an
  // absent body to `{}` server-side, not `""`, so the verifier would
  // recompute a digest of "{}" and always see a mismatch — a request with
  // no body must not claim to have signed one.
  const hasBody = !!body;

  // Prepare headers for signing
  const now = new Date().toUTCString();
  const signHeaders = { host, date: now };
  if (hasBody) {
    const digest = crypto.createHash("sha256").update(bodyStr).digest("base64");
    signHeaders.digest = `SHA-256=${digest}`;
    signHeaders["content-type"] = "application/activity+json";
  }

  // Add to provided headers
  Object.assign(headers, signHeaders);

  // Build signing string
  const headersList = hasBody
    ? ["(request-target)", "host", "date", "digest"]
    : ["(request-target)", "host", "date"];
  const signingString = buildSigningString(method, path, headers, headersList);

  // Sign with server's private key
  const sign = crypto.createSign("SHA256");
  sign.update(signingString);
  sign.end();
  const signature = sign.sign(serverPrivateKey, "base64");

  // Build signature header
  const keyId = `${actorUrl}#main-key`;
  const signatureHeader = [
    `keyId="${keyId}"`,
    `algorithm="rsa-sha256"`,
    `headers="${headersList.join(" ")}"`,
    `signature="${signature}"`,
  ].join(",");

  // Add Signature header
  headers.signature = signatureHeader;

  log.debug("HTTP signature created", {
    method,
    url,
    keyId,
    headers: headersList,
  });

  return {
    headers,
    keyId,
    signingString,
  };
}
