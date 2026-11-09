// /methods/federation/verifyHttpSignature.js
import crypto from "crypto";
import logger from "#methods/utils/logger.js";
import { safeFetch } from "#methods/utils/safeUrl.js";
import { SignatureNonce } from "#schema";

// In-memory public key cache: keyId → { pem, fetchedAt }
const KEY_CACHE = new Map();
const KEY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function parseSignatureHeader(sig) {
  // e.g. keyId="...",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="base64..."
  const out = {};
  for (const part of String(sig || "").split(",")) {
    const [k, v] = part.split("=").map((s) => s.trim());
    if (!k || !v) continue;
    out[k] = v.replace(/^"|"$/g, "");
  }
  return out;
}

function buildSigningString(req, headersList) {
  const method = req.method.toLowerCase();
  const path = req.originalUrl || req.url || "/";
  const lines = [];

  for (const h of headersList) {
    if (h === "(request-target)") {
      lines.push(`(request-target): ${method} ${path}`);
    } else {
      const val = req.get(h);
      if (!val) throw new Error(`missing signed header: ${h}`);
      lines.push(`${h.toLowerCase()}: ${val}`);
    }
  }
  return lines.join("\n");
}

async function fetchPublicKeyFromKeyId(keyId) {
  // Check cache first
  const cached = KEY_CACHE.get(keyId);
  if (cached && Date.now() - cached.fetchedAt < KEY_CACHE_TTL_MS) {
    return cached.keyInfo;
  }

  // Commonly a URL (actor or server key). Fetch it, parse JSON, extract PEM/JWK.
  try {
    // SECURITY: keyId is attacker-chosen (it comes from the Signature
    // header of an unauthenticated request), so fetch it through the shared
    // SSRF guard -- checks every redirect hop and blocks internal hosts.
    const res = await safeFetch(keyId, { method: "GET", timeout: 5000 });
    if (!res.ok) throw new Error(`key fetch ${res.status}`);
    const json = await res.json();
    // Unwrap Kowloon API envelope { item: { ... } }
    const actor = json?.item || json;
    // Try common shapes: {publicKey: {publicKeyPem}}, {publicKeyPem}, or {publicKey: "pem string"}
    const pk = actor?.publicKey;
    const pem =
      (typeof pk === "object" ? pk?.publicKeyPem : null) ||
      (typeof pk === "string" ? pk : null) ||
      actor?.publicKeyPem;
    if (pem) {
      const keyInfo = { type: "pem", key: pem };
      KEY_CACHE.set(keyId, { keyInfo, fetchedAt: Date.now() });
      return keyInfo;
    }
    // JWKS (choose first RSA key)
    if (json?.keys?.length) {
      const keyInfo = { type: "jwks", jwks: json };
      KEY_CACHE.set(keyId, { keyInfo, fetchedAt: Date.now() });
      return keyInfo;
    }
  } catch (e) {
    logger.warn("verifyHttpSignature: key fetch error", {
      keyId,
      error: e.message,
    });
    // Return stale cached key if available (better than failing)
    if (cached) {
      logger.info("verifyHttpSignature: using stale cached key", { keyId });
      return cached.keyInfo;
    }
  }
  throw new Error("unable to resolve key");
}

function verifyWithPem(pem, algo, data, sigB64) {
  const verifier = crypto.createVerify(algo || "RSA-SHA256");
  verifier.update(data);
  verifier.end();
  return verifier.verify(pem, Buffer.from(sigB64, "base64"));
}

function extractDomainFromUrl(url) {
  if (!url) return null;
  const s = String(url);
  // Handle Kowloon handle format: @user@domain or @domain (starts with @)
  if (s.startsWith("@")) {
    const handleMatch = s.match(/@([^@\s]+)$/);
    if (handleMatch) return handleMatch[1].toLowerCase();
  }
  try {
    const parsed = new URL(s);
    return parsed.hostname;
  } catch (e) {
    return null;
  }
}

function verifyDigest(req) {
  const digestHeader = req.get("Digest");
  if (!digestHeader) return { ok: false, error: "Missing Digest header" };

  // Parse digest header, e.g. "SHA-256=base64hash"
  const match = digestHeader.match(/^(SHA-256|SHA-512)=(.+)$/i);
  if (!match) return { ok: false, error: "Invalid Digest format" };

  const [, algo, expectedDigestB64] = match;
  const body = req.body;

  // Calculate digest of actual body
  let bodyStr;
  if (typeof body === "string") {
    bodyStr = body;
  } else if (Buffer.isBuffer(body)) {
    bodyStr = body.toString("utf8");
  } else if (body && typeof body === "object") {
    bodyStr = JSON.stringify(body);
  } else {
    bodyStr = "";
  }

  const hash = crypto.createHash(algo.toLowerCase().replace("-", ""));
  hash.update(bodyStr);
  const actualDigest = hash.digest("base64");

  if (actualDigest !== expectedDigestB64) {
    return { ok: false, error: "Digest mismatch - body has been tampered" };
  }

  return { ok: true };
}

export default async function verifyHttpSignature(
  req,
  { maxSkewMs = 5 * 60 * 1000, actorId = null, verifyReplay = true } = {}
) {
  const sigHeader = req.get("Signature");
  if (!sigHeader) return { ok: false, error: "Missing Signature header" };

  const { keyId, algorithm, headers, signature } =
    parseSignatureHeader(sigHeader);
  if (!keyId || !signature)
    return { ok: false, error: "Invalid Signature header" };

  // Required headers we expect to be signed
  const headersList = (headers || "(request-target) host date digest")
    .split(/\s+/)
    .filter(Boolean);

  // Basic freshness checks
  const date = req.get("Date");
  if (!date) return { ok: false, error: "Missing Date header" };
  const skew = Math.abs(Date.now() - Date.parse(date));
  if (isFinite(skew) && skew > maxSkewMs)
    return { ok: false, error: "Clock skew too large" };

  // SECURITY: Verify digest if present to detect body tampering
  const digestHeader = req.get("Digest");
  if (digestHeader && (req.body || req.method === "POST")) {
    const digestResult = verifyDigest(req);
    if (!digestResult.ok) return digestResult;
  }

  // Build the signing string
  let signingString;
  try {
    signingString = buildSigningString(req, headersList);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  // SECURITY: Check for replay attacks by verifying signature hasn't been used before
  if (verifyReplay) {
    const signatureHash = crypto
      .createHash("sha256")
      .update(signature + keyId + signingString)
      .digest("hex");

    const existing = await SignatureNonce.findOne({ signatureHash }).lean();
    if (existing) {
      return {
        ok: false,
        error: "Replay attack detected - signature already used",
      };
    }

    // Store signature to prevent replay (expires after maxSkewMs + buffer)
    const expiresAt = new Date(Date.now() + maxSkewMs + 60 * 1000); // maxSkewMs + 1 minute buffer
    try {
      await SignatureNonce.create({
        signatureHash,
        keyId,
        requestTarget: `${req.method} ${req.originalUrl || req.url}`,
        expiresAt,
      });
    } catch (e) {
      // Duplicate key error means race condition - another request with same signature
      if (e.code === 11000) {
        return {
          ok: false,
          error: "Replay attack detected - duplicate signature",
        };
      }
      // Other errors - log but don't fail (replay protection is defense in depth)
      logger.warn("Failed to store signature nonce", { error: e.message });
    }
  }

  // Resolve key + verify
  let keyInfo;
  try {
    keyInfo = await fetchPublicKeyFromKeyId(keyId);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  let ok = false;
  if (keyInfo.type === "pem") {
    ok = verifyWithPem(
      keyInfo.key,
      (algorithm || "rsa-sha256").toUpperCase(),
      signingString,
      signature
    );
  } else {
    // TODO: implement JWKS verify if needed (map algo to node verifier)
    return {
      ok: false,
      error: "JWKS verification not implemented in this stub",
    };
  }

  if (!ok) return { ok: false, error: "Invalid HTTP Signature" };

  // SECURITY: Verify domain consistency between actor and keyId
  // This prevents impersonation attacks where someone signs with a key from domain A
  // but claims to be an actor from domain B
  if (actorId) {
    const actorDomain = extractDomainFromUrl(actorId);
    const keyDomain = extractDomainFromUrl(keyId);

    if (!actorDomain || !keyDomain) {
      logger.warn("Could not extract domains for verification", {
        actorId,
        keyId,
      });
    } else if (actorDomain !== keyDomain) {
      return {
        ok: false,
        error: `Domain mismatch: actor domain (${actorDomain}) does not match keyId domain (${keyDomain})`,
      };
    }
  }

  // Extract domain from Host
  const host = req.get("Host") || "";
  const domain = host.replace(/:\d+$/, "");

  return { ok: true, domain, keyId };
}
