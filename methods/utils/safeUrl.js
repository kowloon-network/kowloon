// Shared SSRF guard. Resolves a hostname to ALL of its IPs and rejects the URL
// if any of them falls in a loopback / private / CGNAT / link-local /
// reserved range, plus localhost variants, single-label / docker-internal
// names, and non-http(s) schemes. Used wherever the server fetches a URL that
// a user or a remote server chose (link previews, og:image proxying,
// federation key/object fetches, ...).
//
// `safeFetch()` wraps fetch(): it re-runs the guard on EVERY redirect hop
// (redirects are followed manually, max 5) and always applies a timeout. A
// plain fetch() follows redirects internally, so checking only the first URL
// let a public host 302 us to http://169.254.169.254/ or http://mongo-shared/.
//
// Residual risk (documented, not fixed here): DNS rebinding between our
// lookup and fetch's own lookup. Closing that needs a pinned-IP dispatcher
// (undici Agent with a custom `connect.lookup`), and undici isn't a direct
// dependency.
//
// Dev escape hatch: local federation runs on kwln1.local / kwln2.local /
// localhost, which resolve to private addresses. Set ALLOW_PRIVATE_FETCH=true
// (wired in docker-compose.yml for the dev stacks) to skip the address checks.
// Deliberately NOT keyed on NODE_ENV, so a production box that forgets to set
// NODE_ENV=production doesn't silently lose its SSRF protection.

import dns from 'dns';
import net from 'net';

export function allowPrivateFetch() {
  return /^(1|true|yes)$/i.test(process.env.ALLOW_PRIVATE_FETCH || '');
}

// Container / infra hostnames that must never be fetched even if someone
// gives them a dot-less or search-domain-resolvable name.
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'mongo', 'mongodb', 'mongo-shared',
  'minio', 'minio-shared',
  'glitchtip', 'redis', 'nginx', 'caddy',
  'metadata', 'metadata.google.internal',
]);

function ipv4ToInt(addr) {
  return addr.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

function inV4Cidr(addr, base, bits) {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(addr) & mask) === (ipv4ToInt(base) & mask);
}

const PRIVATE_V4 = [
  ['0.0.0.0', 8],        // "this network"
  ['10.0.0.0', 8],       // private
  ['100.64.0.0', 10],    // CGNAT / Tailscale
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local (cloud metadata)
  ['172.16.0.0', 12],    // private (docker bridge networks)
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // TEST-NET-1
  ['192.168.0.0', 16],   // private
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // TEST-NET-2
  ['203.0.113.0', 24],   // TEST-NET-3
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved + broadcast
];

// Expand an IPv6 string to 8 16-bit groups (handles :: and embedded IPv4).
function expandV6(addr) {
  let a = addr.toLowerCase().split('%')[0];
  const v4 = a.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    a = a.slice(0, -v4[1].length) + ((n >>> 16).toString(16)) + ':' + ((n & 0xffff).toString(16));
  }
  const [head, tail] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = a.includes('::') ? new Array(8 - h.length - t.length).fill('0') : [];
  return [...h, ...fill, ...t].map((g) => parseInt(g || '0', 16));
}

export function isPrivateIp(ip) {
  if (typeof ip !== 'string') return true;

  if (net.isIPv4(ip)) {
    return PRIVATE_V4.some(([base, bits]) => inV4Cidr(ip, base, bits));
  }

  if (net.isIPv6(ip)) {
    const g = expandV6(ip);
    if (g.length !== 8 || g.some((x) => Number.isNaN(x))) return true;
    // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64
    // (64:ff9b::a.b.c.d) -- judge by the embedded IPv4 address.
    const embedded = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
    const first5Zero = g.slice(0, 5).every((x) => x === 0);
    if (first5Zero && (g[5] === 0xffff || g[5] === 0)) {
      if (g[5] === 0 && g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true; // :: and ::1
      return isPrivateIp(embedded);
    }
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
      return isPrivateIp(embedded);
    }
    return (
      (g[0] & 0xfe00) === 0xfc00 || // fc00::/7 unique local
      (g[0] & 0xffc0) === 0xfe80 || // fe80::/10 link-local
      (g[0] & 0xffc0) === 0xfec0 || // fec0::/10 site-local (deprecated)
      (g[0] & 0xff00) === 0xff00 || // ff00::/8 multicast
      (g[0] === 0x2001 && g[1] === 0x0db8) || // 2001:db8::/32 documentation
      (g[0] === 0x2002) // 6to4 -- can embed private v4; reject outright
    );
  }

  return true; // Unknown format -- reject
}

// Hostname-level checks that don't need DNS.
function isBlockedHostname(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (h.endsWith('.localhost') || h.endsWith('.internal')) return true;
  // Single-label names (no dot) resolve via docker's embedded DNS / search
  // domains to internal services (mongo-shared, minio-shared, glitchtip...).
  if (!h.includes('.') && !net.isIP(h)) return true;
  return false;
}

export async function isSafeUrl(urlStr) {
  let parsed;
  try { parsed = new URL(urlStr); } catch { return false; }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  // Credentials in URLs are never legitimate for our fetches.
  if (parsed.username || parsed.password) return false;

  if (allowPrivateFetch()) return true;

  // URL.hostname keeps the [] around IPv6 literals.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

  if (net.isIP(hostname)) return !isPrivateIp(hostname);
  if (isBlockedHostname(hostname)) return false;

  // Resolve ALL addresses -- a host with one public and one private record
  // must not pass just because lookup() happened to return the public one.
  try {
    const addrs = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    if (!addrs.length) return false;
    return addrs.every(({ address }) => !isPrivateIp(address));
  } catch {
    return false;
  }
}

export class UnsafeUrlError extends Error {
  constructor(url) {
    super(`Refusing to fetch unsafe URL: ${url}`);
    this.name = 'UnsafeUrlError';
    this.code = 'UNSAFE_URL';
  }
}

// Nothing is ever fetched from a server on the Defederated list -- link
// lookups, thread hydration, keys, media, pulls all come through here
// (methods/moderation/federationPolicy.js). Lazy import: this module is
// low-level and loaded long before the database is.
export class DefederatedError extends Error {
  constructor(url) {
    super(`Not fetching from a defederated server: ${url}`);
    this.name = 'DefederatedError';
    this.code = 'DEFEDERATED';
    this.status = 403;
  }
}

async function isDefederatedUrl(url) {
  try {
    const { isDefederated } = await import('#methods/moderation/federationPolicy.js');
    return await isDefederated(url);
  } catch {
    return false; // lists unavailable (no DB yet, e.g. a script): don't block
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;

/**
 * fetch() with the SSRF guard applied to the initial URL and every redirect
 * hop. Same signature as fetch(); extra opts:
 *   - timeout (ms, default 10s)       -- AbortSignal.timeout, merged with opts.signal
 *   - maxRedirects (default 5)
 * Throws UnsafeUrlError if any hop is unsafe. `redirect` in opts is ignored
 * (always followed manually); pass maxRedirects: 0 to not follow at all.
 */
export async function safeFetch(url, opts = {}) {
  const {
    timeout = DEFAULT_TIMEOUT_MS,
    maxRedirects = MAX_REDIRECTS,
    signal,
    redirect: _ignored,
    ...rest
  } = opts;
  const timeoutSignal = AbortSignal.timeout(timeout);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let current = String(url);
  let init = { ...rest };
  const origin0 = (() => { try { return new URL(current).origin; } catch { return null; } })();

  for (let hop = 0; ; hop++) {
    if (!(await isSafeUrl(current))) throw new UnsafeUrlError(current);
    if (await isDefederatedUrl(current)) throw new DefederatedError(current);

    const res = await fetch(current, { ...init, redirect: 'manual', signal: combined });
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location || maxRedirects === 0) {
      return res;
    }
    if (hop >= maxRedirects) {
      try { await res.body?.cancel(); } catch {}
      throw new Error(`Too many redirects fetching ${url}`);
    }
    try { await res.body?.cancel(); } catch {}

    const next = new URL(location, current).toString();
    // 303, and 301/302 on non-GET, switch to GET without a body (fetch spec).
    const method = (init.method || 'GET').toUpperCase();
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      init = { ...init, method: 'GET' };
      delete init.body;
    }
    // Never forward credentials (or our HTTP signature) to another origin.
    if (origin0 && new URL(next).origin !== origin0 && init.headers) {
      const h = new Headers(init.headers);
      for (const k of ['authorization', 'cookie', 'signature', 'digest']) h.delete(k);
      init = { ...init, headers: h };
    }
    current = next;
  }
}
