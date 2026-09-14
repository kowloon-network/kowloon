// methods/parse/serverDomain.js
// Normalise the many ways a person might name a server into a bare domain.
//
// Admins paste whatever they have to hand — a Kowloon server id, a URL they
// copied from the address bar, or just the domain — and all three should mean
// the same thing:
//
//   "@kwln.social"                -> "kwln.social"
//   "https://kwln.social"         -> "kwln.social"
//   "https://kwln.social/users/x" -> "kwln.social"
//   "kwln.social"                 -> "kwln.social"
//   "KWLN.Social"                 -> "kwln.social"
//   "kwln.social:3000"            -> "kwln.social"
//   "@alice@kwln.social"          -> "kwln.social"   (a user handle, not a
//                                                     server — take the host)
//
// Returns null for anything that doesn't end up looking like a hostname, so
// callers can reject instead of writing junk rows.

export default function parseServerDomain(input) {
  if (typeof input !== "string") return null;

  let s = input.trim().toLowerCase();
  if (!s) return null;

  s = s.replace(/^https?:\/\//, ""); // scheme
  s = s.replace(/\/.*$/, ""); // path, query, fragment
  s = s.replace(/^@/, ""); // leading @ of a server id

  // A user handle (@alice@kwln.social) still has an @ left; the host is the
  // last segment. Doing this after stripping the leading @ means both
  // "@alice@host" and "alice@host" land on the host.
  if (s.includes("@")) s = s.slice(s.lastIndexOf("@") + 1);

  s = s.replace(/:\d+$/, ""); // port
  s = s.replace(/\.$/, ""); // trailing dot on an FQDN

  // Must look like a hostname: labels of alphanumerics/hyphens, at least one
  // dot, no leading/trailing hyphen in a label.
  if (!/^(?!-)[a-z0-9-]+(?<!-)(\.(?!-)[a-z0-9-]+(?<!-))+$/.test(s)) return null;

  return s;
}
