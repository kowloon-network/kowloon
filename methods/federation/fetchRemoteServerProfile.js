// /methods/federation/fetchRemoteServerProfile.js
// Fetch a remote Kowloon server's public profile and upsert it into the
// local FederatedServer cache. Calls GET /profile on the remote server,
// which returns metadata + top-20 circles/groups + all public pages in
// one round-trip.
//
// Triggers: first visit to a server, stale profileFetchedAt, or when a
// local user adds @domain to a circle for the first time.

import { FederatedServer } from "#schema";
import sanitizeHtml from "#methods/utils/sanitize.js";
import { getServerSettings } from "#methods/settings/schemaHelpers.js";
import logger from "#methods/utils/logger.js";
import parseServerDomain from "#methods/parse/serverDomain.js";

function stripHtml(str) {
  if (!str) return null;
  return sanitizeHtml(String(str), { allowedTags: [], allowedAttributes: {} }).trim() || null;
}

/**
 * Fetch and cache a remote Kowloon server's public profile.
 *
 * @param {string} domain - Remote server domain (e.g. "kowloon.network")
 * @param {Object} [opts]
 * @param {boolean} [opts.force=false] - Refresh even if profileFetchedAt is recent
 * @param {number}  [opts.staleSecs=3600] - Seconds before a cached profile is considered stale
 * @returns {Promise<{ server: Object|null, error: string|null }>}
 */
export default async function fetchRemoteServerProfile(domain, { force = false, staleSecs = 3600 } = {}) {
  domain = parseServerDomain(domain) || domain;

  const { domain: ourDomain } = getServerSettings();
  if (domain === ourDomain) {
    return { server: null, error: "Cannot fetch profile for own server" };
  }

  // Skip if cached data is fresh enough
  if (!force) {
    const existing = await FederatedServer.findOne({ domain }).lean();
    if (existing?.status === "suspended") {
      return { server: null, error: "Server is suspended" };
    }
    if (existing?.profileFetchedAt) {
      const ageMs = Date.now() - new Date(existing.profileFetchedAt).getTime();
      if (ageMs < staleSecs * 1000) {
        return { server: existing, error: null };
      }
    }
  }

  const url = `https://${domain}/profile`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": `Kowloon/${ourDomain}`,
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const msg = `HTTP ${response.status}`;
      logger.warn("fetchRemoteServerProfile: fetch failed", { domain, status: response.status });
      return { server: null, error: msg };
    }

    const data = await response.json();
    const now = new Date();

    // Defensive: absolutize relative asset paths against the source domain, in
    // case a peer hasn't upgraded to emit absolute icon/image URLs.
    const absAsset = (v) =>
      v && !/^https?:\/\//i.test(v)
        ? `https://${domain}${v.startsWith("/") ? "" : "/"}${v}`
        : v || null;

    // Map circles → CachedCircle shape (cap at 20, defensive)
    const cachedCircles = (data.circles || []).slice(0, 20).map((c) => ({
      id:          c.id          || "",
      name:        c.name        || "",
      summary:     stripHtml(c.summary),
      icon:        c.icon        || null,
      url:         c.url         || null,
      memberCount: c.memberCount || 0,
      reactCount:  c.reactCount  || 0,
    })).filter((c) => c.id);

    // Map groups → CachedGroup shape
    const cachedGroups = (data.groups || []).slice(0, 20).map((g) => ({
      id:          g.id          || "",
      name:        g.name        || "",
      summary:     stripHtml(g.summary),
      icon:        g.icon        || null,
      image:       g.image       || null,
      url:         g.url         || null,
      memberCount: g.memberCount || 0,
      rsvpPolicy:  g.rsvpPolicy  || null,
    })).filter((g) => g.id);

    // Map pages → CachedPage shape (title + url required)
    const cachedPages = (data.pages || []).map((p) => ({
      title: p.title || "",
      url:   p.url   || "",
      icon:  p.icon  || null,
    })).filter((p) => p.title && p.url);

    const update = {
      // Profile metadata
      name:              data.name              || domain,
      icon:              absAsset(data.icon),
      image:             absAsset(data.image),
      description:       stripHtml(data.description),
      language:          Array.isArray(data.language) ? data.language : [],
      openRegistrations: !!data.openRegistrations,
      userCount:         typeof data.userCount === "number" ? data.userCount : undefined,
      postCount:         typeof data.postCount  === "number" ? data.postCount  : undefined,
      location:          data.location          || null,
      profileFetchedAt:  now,

      // Cached content
      cachedCircles,
      circlesFetchedAt: now,
      cachedGroups,
      groupsFetchedAt: now,
      cachedPages,
      pagesFetchedAt: now,

      // Mark active if we could reach it
      status: "active",
    };

    // Remove undefined fields so $set doesn't null them out
    for (const key of Object.keys(update)) {
      if (update[key] === undefined) delete update[key];
    }

    const server = await FederatedServer.findOneAndUpdate(
      { domain },
      {
        $set: update,
        $setOnInsert: {
          domain,
          discoveredAt: now,
          discoveredVia: "manual",
          pullIntervalMs: 300000,
          nextPullAt: now,
        },
      },
      { upsert: true, new: true }
    ).lean();

    logger.info("fetchRemoteServerProfile: cached profile", {
      domain,
      circles: cachedCircles.length,
      groups:  cachedGroups.length,
      pages:   cachedPages.length,
    });

    return { server, error: null };
  } catch (error) {
    logger.error("fetchRemoteServerProfile: error", { domain, error: error.message });
    return { server: null, error: error.message };
  }
}
