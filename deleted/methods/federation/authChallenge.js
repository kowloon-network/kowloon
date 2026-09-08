// /methods/federation/authChallenge.js
import crypto from "crypto";

const NONCES = new Map(); // { key: { nonce, exp } }  -- replace with Redis/Mongo in prod

function key(viewer, userId) {
  return `${viewer}::${userId}`;
}

export async function startChallenge({ viewer, userId, ttlMs = 90_000 }) {
  const nonce = crypto.randomBytes(24).toString("base64url");
  const exp = Date.now() + ttlMs;
  NONCES.set(key(viewer, userId), { nonce, exp });
  return { nonce, exp };
}

export async function finishChallenge({ viewer, userId, nonce, verified }) {
  const k = key(viewer, userId);
  const rec = NONCES.get(k);
  if (!rec) return { ok: false, error: "No challenge" };
  NONCES.delete(k);
  if (Date.now() > rec.exp) return { ok: false, error: "Challenge expired" };
  if (rec.nonce !== nonce) return { ok: false, error: "Nonce mismatch" };

  // `verified` should be result of signature verification performed upstream
  if (!verified) return { ok: false, error: "Signature invalid" };

  return { ok: true };
}
