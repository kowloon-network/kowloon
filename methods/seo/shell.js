// methods/seo/shell.js
// Build <head> meta tags for a page. `renderHeadTags` is reused both by the
// crawler shell (renderShell) and by the SPA meta injection so a real browser
// gets the same per-item Open Graph / Twitter / kowloon:id tags a crawler does.

function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Make a JSON string safe to embed in a <script> element. JSON.stringify does
// not escape "<", so a post title containing "</script><script>..." would
// break out of the ld+json block (stored XSS). These characters can only
// appear inside JSON strings, where \uXXXX escapes are equivalent.
function escJsonForScript(json) {
  return String(json)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// Returns the block of <head> meta tags (no wrapping <html>/<head>). `kowloonId`
// / `kowloonType` are emitted as custom meta so any Kowloon client can read an
// object's canonical ID straight off a shared URL — server-agnostic.
export function renderHeadTags({ title, description, image, url, type, siteName, kowloonId, kowloonType, jsonLd }) {
  const t = esc(title);
  const d = esc(description);
  const i = esc(image || "");
  const u = esc(url);
  const s = esc(siteName);

  return `  <title>${t}</title>
  <meta name="description" content="${d}">
  <link rel="canonical" href="${u}">

  <!-- Open Graph -->
  <meta property="og:title" content="${t}">
  <meta property="og:description" content="${d}">
  <meta property="og:url" content="${u}">
  <meta property="og:site_name" content="${s}">
  <meta property="og:type" content="${esc(type || "website")}">
  ${i ? `<meta property="og:image" content="${i}">` : ""}

  <!-- Twitter Card -->
  <meta name="twitter:card" content="${i ? "summary_large_image" : "summary"}">
  <meta name="twitter:title" content="${t}">
  <meta name="twitter:description" content="${d}">
  ${i ? `<meta name="twitter:image" content="${i}">` : ""}
${kowloonId ? `\n  <!-- Kowloon -->\n  <meta name="kowloon:id" content="${esc(kowloonId)}">\n  <meta name="kowloon:type" content="${esc(kowloonType || "")}">\n` : ""}
  ${jsonLd ? `<script type="application/ld+json">${escJsonForScript(jsonLd)}</script>` : ""}`;
}

export function renderShell(meta) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
${renderHeadTags(meta)}
</head>
<body></body>
</html>`;
}
