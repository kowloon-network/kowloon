// methods/utils/sanitizeRemote.js
//
// SECURITY (2026-11-09): HTML that arrives from ANOTHER server (pulled feed
// items, proxied replies, hydrated remote pages) used to be stored and
// served exactly as received, and both web clients render body/summary as
// HTML. A malicious or compromised peer could therefore run script in our
// origin and steal users' login tokens. Everything rendered as HTML that we
// did not generate ourselves must pass through here first.
//
// The allowlist mirrors what local posts are allowed to contain
// (schema/Post.js ALLOWED_TAGS / ALLOWED_ATTRIBUTES).

import sanitizeHtml from "#methods/utils/sanitize.js";

const ALLOWED_TAGS = [
  "p", "br", "strong", "em", "s", "u", "a", "ul", "ol", "li",
  "blockquote", "code", "pre", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "img",
];
const ALLOWED_ATTRIBUTES = {
  a: ["href", "title", "rel", "target"],
  img: ["src", "alt", "title"],
  code: ["class"],
  pre: ["class"],
};

export function sanitizeRemoteHtml(html) {
  if (typeof html !== "string") return html == null ? html : "";
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: ["http", "https", "mailto"],
    disallowedTagsMode: "discard",
  });
}

// Sanitize the HTML-bearing fields of a remote content object in place-safe
// fashion (returns a shallow copy). Covers the fields clients render as HTML.
export function sanitizeRemoteObject(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const out = { ...obj };
  for (const k of ["body", "summary", "content"]) {
    if (typeof out[k] === "string") out[k] = sanitizeRemoteHtml(out[k]);
  }
  // Plain-text fields (title, name, source.content) are deliberately left
  // alone: clients render them as text, and running them through an HTML
  // sanitizer would turn "&" and "<" into visible entities.
  if (out.event && typeof out.event === "object" && typeof out.event.description === "string") {
    out.event = { ...out.event, description: sanitizeRemoteHtml(out.event.description) };
  }
  return out;
}
