// methods/files/signedUrl.js
// App-level signed file URLs.
//
// Files stream through GET /files/:id from internal object storage (no public
// storage surface). Public files serve to anyone, so they get a plain, stable,
// cacheable URL that federation peers can fetch indefinitely. Restricted files
// can't be loaded by a bare <img> tag (browsers don't send the Authorization
// header), so the API embeds a short-lived signature that grants access to that
// one file — the same property presigned S3 URLs gave us, without exposing the
// viewer's JWT or a public storage endpoint.

import crypto from "crypto";
import kowloonId from "#methods/parse/kowloonId.js";
import isLocalDomain from "#methods/parse/isLocalDomain.js";

function secret() {
  // Same secret the app already holds; present in the app and worker envs.
  return process.env.JWT_SECRET || process.env.FILE_URL_SECRET || "";
}

// Size is intentionally NOT part of the signature so clients can append
// &size=<n> to fetch a thumbnail of the same (already-authorized) file.
function sign(fileId, exp) {
  return crypto
    .createHmac("sha256", secret())
    .update(`${fileId}:${exp}`)
    .digest("base64url");
}

export function verifyFileSig(fileId, exp, sig) {
  if (!fileId || !exp || !sig || !secret()) return false;
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum * 1000 < Date.now()) return false;
  const expected = sign(fileId, String(exp));
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Treat empty/`@public`/`public` as public; everything else (server, circle,
// group, user IDs) is restricted.
export function isPublicVisibility(to) {
  const v = String(to ?? "").trim().toLowerCase();
  return v === "" || v === "@public" || v === "public";
}

// Build the public URL for a file served by GET /files/:id.
export function buildFileUrl({ fileId, domain, protocol = "https", restricted = false, ttlSeconds = 3600, version }) {
  // Keep the file id raw (no encoding) to match the URLs the rest of the
  // codebase builds (upload.js, proxyExternalImage.js) and the frontend's
  // sizedUrl regex, which keys on a literal `file:`. File ids contain no '/'.
  const base = `${protocol}://${domain}/files/${fileId}`;
  // Optional content-version cache-buster. Image bytes at a key can change
  // (e.g. an orientation fix), but the URL is stable and clients — especially
  // expo-image on mobile — cache by URL, pinning the stale image. Threading the
  // file's updatedAt as ?v= makes the URL change when the content does, so fixes
  // propagate. sizedUrl (frontend) already appends &size= when a ? is present.
  const vParam = version != null && version !== "" ? `v=${encodeURIComponent(version)}` : "";
  if (!restricted) return vParam ? `${base}?${vParam}` : base;
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  let q = `exp=${exp}&sig=${sign(fileId, String(exp))}`;
  if (vParam) q += `&${vParam}`;
  return `${base}?${q}`;
}

// Resolve a File doc to a client-usable URL. Any file with a local storageKey
// — local upload or remote-cached bytes (see hydrateRemoteFile.js) — gets a
// (possibly signed, version-busted) /files/:id URL on THIS server, since our
// own proxy can serve it directly. A remote shadow with no storageKey yet
// (not cached, or restricted — see issue #57) falls back to its stored origin
// URL so it still renders while hydration catches up.
export function fileServeUrl(file, { domain, protocol = "https", restricted = false } = {}) {
  if (!file) return null;
  if (!file.storageKey) {
    const parsed = kowloonId(file.id);
    if (parsed?.domain && !isLocalDomain(parsed.domain)) {
      return file.url || null; // not cached locally — bytes live at the origin
    }
  }
  const version = file.updatedAt ? new Date(file.updatedAt).getTime() : undefined;
  return buildFileUrl({ fileId: file.id, domain, protocol, restricted, version });
}
