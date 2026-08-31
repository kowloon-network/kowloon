// Discover heuristic — "popular, lightly shuffled" fill for hybrid/heuristic
// rows. Not a personalized algorithm: a transparent weighting of engagement
// (posts/media) or size (circles/groups/servers), a soft boost for "complete"
// items (real icon/description or a featured image), and a daily-seeded shuffle
// so the surface feels fresh without churning every request.
//
// Returns raw { ref, refType, doc } so the read route shapes them with its one
// shapeCard(). Viewer-tier aware; pools cached ~5 min per (type, tier, day).

import { FeedItems, Circle, Group, FederatedServer } from "#schema";

const CACHE = new Map(); // `${contentType}:${isLocal}:${daySeed}` -> { at, pool }
const TTL_MS = 5 * 60 * 1000;

const DECAY_K = 12; // hours — softens the age penalty
const GRAVITY = 1.4;
const W_REACT = 1;
const W_REPLY = 2; // a reply is a stronger signal than a react
const BOOST = 1.5; // completeness multiplier (soft — never a filter)
const POOL = 40; // shuffle pool size (>= any targetCount)
const CANDIDATES = 120; // rows scanned before scoring
const REMOTE_FRAC = 0.35; // cap on cached-remote posts in the pool (stay home-anchored)
const PLACEHOLDER_RE = /\/images\/(circle|group|user)\.svg/i;

// Daily seed (UTC): stable within a day, rotates at midnight.
function daySeed() {
  const d = new Date();
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

// Mulberry32 — deterministic PRNG for the daily shuffle.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededShuffle(arr, seed) {
  const r = rng(seed);
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function toFilter(isLocal, localDomain) {
  return isLocal ? { to: { $in: ["@public", `@${localDomain}`] } } : { to: "@public" };
}

// Coarse-`to` filter for the FeedItems store (enum: public/server/audience).
// Local viewers get server-tier too; anon/remote get public only.
function feedVisFilter(isLocal) {
  return isLocal ? { to: { $in: ["public", "server"] } } : { to: "public" };
}

// Adapt a FeedItem into the Post-shaped doc shapeCard()/scoring expect. The
// `object` subdoc already carries the content fields (type/title/textPreview/
// image/attachments/actor); we layer on the canonical id, a *fine* `to`
// (FeedItems store the coarse enum, but tierOf/shapeCard want @public/@domain)
// and the feed sort time as createdAt. Exported so the read route resolves
// curated Post refs the same way — from the FeedItem, not the local Post record
// (which lets curated *remote* posts resolve too).
export function fiToPostDoc(fi, localDomain) {
  const o = fi.object || {};
  const to =
    fi.to === "server" ? `@${localDomain}` : "@public"; // audience never surfaces here
  return {
    ...o,
    id: fi.id,
    to,
    type: fi.type || o.type,
    actorId: fi.actorId || o.actorId,
    url: fi.url || o.url,
    createdAt: fi.publishedAt || o.createdAt,
  };
}

const hasIcon = (v) => !!v && !PLACEHOLDER_RE.test(v);

function decayedEngagement(doc, now) {
  const eng = (doc.reactCount || 0) * W_REACT + (doc.replyCount || 0) * W_REPLY;
  const ageH = Math.max(0, (now - new Date(doc.createdAt).getTime()) / 3.6e6);
  return (eng + 1) / Math.pow(ageH + DECAY_K, GRAVITY);
}

async function buildPool(contentType, isLocal, localDomain) {
  const now = Date.now();
  const vis = toFilter(isLocal, localDomain);
  let scored = [];

  if (contentType === "media" || contentType === "posts") {
    const typeQ = contentType === "media" ? { type: "Media" } : { type: { $ne: "Media" } };
    // Pull from FeedItems — the unified local+remote public store the feed itself
    // reads — rather than the local Post model, so Discover surfaces cached
    // remote content too. Each item's `object` is already post-shaped.
    const items = await FeedItems.find({
      objectType: "Post",
      tombstoned: { $ne: true },
      ...typeQ,
      ...feedVisFilter(isLocal),
    })
      .sort({ "object.reactCount": -1, publishedAt: -1 })
      .limit(CANDIDATES)
      .lean();
    scored = items.map((fi) => {
      const doc = fiToPostDoc(fi, localDomain);
      const hasImg = !!doc.image || (Array.isArray(doc.attachments) && doc.attachments.length > 0);
      const complete = contentType === "media" ? hasImg : !!doc.image;
      const isRemote = !!fi.originDomain && fi.originDomain !== localDomain;
      return { ref: doc.id, refType: "Post", doc, isRemote, score: decayedEngagement(doc, now) * (complete ? BOOST : 1) };
    });
    // Soft cap on cached-remote posts so Discover stays mostly home content.
    scored.sort((a, b) => b.score - a.score);
    const maxRemote = Math.round(POOL * REMOTE_FRAC);
    const local = scored.filter((s) => !s.isRemote);
    const remote = scored.filter((s) => s.isRemote).slice(0, maxRemote);
    scored = [...local.slice(0, POOL - remote.length), ...remote];
  } else if (contentType === "circles") {
    // Exclude server-owned circles (actorId === the bare server, e.g. the
    // "KWLN Admins" admin roster and any curated-people circles). Those are
    // admin-managed / internal and must never be auto-surfaced — they appear in
    // Discover only when EXPLICITLY curated via a Discovery item.
    const docs = await Circle.find({
      type: "Circle",
      deletedAt: null,
      actorId: { $ne: `@${localDomain}` },
      ...vis,
    })
      .sort({ memberCount: -1 })
      .limit(CANDIDATES)
      .lean();
    scored = docs.map((doc) => {
      const complete = hasIcon(doc.icon) && !!doc.summary;
      return { ref: doc.id, refType: "Circle", doc, score: ((doc.memberCount || 0) + 1) * (complete ? BOOST : 1) };
    });
  } else if (contentType === "groups") {
    const docs = await Group.find({ deletedAt: null, ...vis })
      .sort({ memberCount: -1 })
      .limit(CANDIDATES)
      .lean();
    scored = docs.map((doc) => {
      const complete = hasIcon(doc.icon) && !!doc.description;
      return { ref: doc.id, refType: "Group", doc, score: ((doc.memberCount || 0) + 1) * (complete ? BOOST : 1) };
    });
  } else if (contentType === "servers") {
    const docs = await FederatedServer.find({ status: { $nin: ["suspended", "blocked"] } })
      .sort({ localFollowerCount: -1, userCount: -1 })
      .limit(CANDIDATES)
      .lean();
    scored = docs.map((doc) => {
      const complete = hasIcon(doc.icon) && !!doc.description;
      const base = (doc.localFollowerCount || 0) * 3 + (doc.userCount || 0) + 1;
      return { ref: `@${doc.domain}`, refType: "Server", doc, score: base * (complete ? BOOST : 1) };
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return seededShuffle(scored.slice(0, POOL), daySeed());
}

/**
 * @param {Object} opts
 * @param {"media"|"posts"|"circles"|"groups"|"servers"} opts.contentType
 * @param {boolean} opts.isLocal      Viewer is an authenticated local user.
 * @param {string}  opts.localDomain
 * @param {Set<string>} [opts.excludeRefs] Curated refs already in the row.
 * @param {number}  opts.limit        How many to backfill.
 * @returns {Promise<Array<{ref:string, refType:string, doc:Object}>>}
 */
export default async function getHeuristicPicks({ contentType, isLocal, localDomain, excludeRefs = new Set(), limit = 12 }) {
  if (limit <= 0 || !contentType) return [];
  const key = `${contentType}:${isLocal ? 1 : 0}:${daySeed()}`;
  let entry = CACHE.get(key);
  if (!entry || Date.now() - entry.at >= TTL_MS) {
    entry = { at: Date.now(), pool: await buildPool(contentType, isLocal, localDomain) };
    CACHE.set(key, entry);
  }
  const out = [];
  for (const p of entry.pool) {
    if (out.length >= limit) break;
    if (excludeRefs.has(p.ref)) continue;
    out.push({ ref: p.ref, refType: p.refType, doc: p.doc });
  }
  return out;
}
