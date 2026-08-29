// methods/seo/resolveRequestDomain.js
// Every SEO/social-preview URL (og:url, og:image, canonical, JSON-LD) is
// built from a single global Settings.domain value — correct for the vast
// majority of requests, but wrong for pics.<domain>: the exact same app
// process also serves that subdomain (see src/pics/ in the frontend), and
// without this, a request arriving on pics.kwln.dev would still build every
// URL against kwln.dev, misattributing the preview to the wrong domain.
//
// Prefers the incoming request's own Host header, but ONLY when it's a
// domain this server actually recognizes as itself (the configured domain,
// or its pics.<domain> lens) — never blindly trusts an arbitrary Host header
// for canonical URL generation (a spoofed Host could otherwise inject
// attacker-controlled domains into og:url/JSON-LD). Falls back to the
// configured domain for anything else, matching the previous behavior.

import { getSetting } from "#methods/settings/cache.js";

export default function resolveRequestDomain(req) {
  const configured = getSetting("domain");
  const incoming = (req.hostname || "").toLowerCase();
  if (!configured) return incoming || configured;
  if (incoming === configured || incoming === `pics.${configured}`) return incoming;
  return configured;
}
