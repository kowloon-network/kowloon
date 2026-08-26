// /methods/federation/pullFromRemote.js
// Pull content from a remote server using the batch-pull protocol.
//
// For user follows (from = individual actors):
//   Sends GET /outbox?from=...&to=... to the remote server.
//   Remote knows its own circle memberships, so it computes which `to` users
//   should receive each item (public posts + circle-addressed posts).
//   FanOut is built from the `recipients` map the remote returns.
//
// For server follows (from = bare @domain entries only):
//   Posts are @public — they are not addressed to any specific user.
//   The remote cannot know who on this server subscribed; the local server does.
//   `recipients` from the remote is ignored. FanOut is created locally for ALL
//   users in `to` (the caller passes every local subscriber).

import crypto from "crypto";
import { FeedItems, FeedFanOut, User, Circle, Post } from "#schema";
import { notifyFeedFanOut } from "#methods/notifications/notifyFeedActivity.js";
import logger from "#methods/utils/logger.js";
import { getServerSettings } from "#methods/settings/schemaHelpers.js";
import { fileIdFromValue } from "#methods/files/fileRef.js";
import { hydrateRemoteFiles } from "#methods/files/hydrateRemoteFile.js";

function dedupeHash(feedItemId, to) {
  return crypto.createHash("sha256").update(`${feedItemId}:${to}`).digest("hex");
}

function isServerEntry(id) {
  return typeof id === "string" && id.startsWith("@") && !id.slice(1).includes("@");
}

/**
 * Pull content from a remote server on behalf of local users.
 *
 * @param {Object} options
 * @param {string}   options.remoteDomain  - Required: remote server to pull from
 * @param {string[]} options.from          - Remote users/servers to pull from
 *                                           (user: "@alice@kwln2.local", server: "@kwln2.local")
 * @param {string[]} options.to            - Local user IDs to fan out to.
 *                                           For server follows: ALL local subscribers.
 *                                           For user follows: users the remote should filter for.
 * @param {string|Date} [options.since]    - Only items after this timestamp
 * @param {number}   [options.limit=100]   - Max items to retrieve
 *
 * @returns {Promise<{ items: Array, nextCursor: string|null, error: string|null }>}
 */
export default async function pullFromRemote({
  remoteDomain,
  from = [],
  to = [],
  since = null,
  limit = 100,
} = {}) {
  if (!remoteDomain) {
    return { items: [], nextCursor: null, error: "remoteDomain is required" };
  }
  if (from.length === 0) {
    return { items: [], nextCursor: null, error: "from is required" };
  }
  if (to.length === 0) {
    return { items: [], nextCursor: null, error: "to is required" };
  }

  // A server-only pull is when every `from` entry is a bare @domain (no individual users).
  // For these, posts are @public — FanOut is computed locally from `to`, not from
  // the remote's `recipients` array.
  const serverOnlyPull = from.every(isServerEntry);

  const { domain: ourDomain } = getServerSettings();

  try {
    const params = new URLSearchParams();
    from.forEach((f) => params.append("from", f));
    to.forEach((t) => params.append("to", t));
    if (since) {
      const sinceDate = since instanceof Date ? since : new Date(since);
      params.append("since", sinceDate.toISOString());
    }
    params.append("limit", String(limit));

    const url = `https://${remoteDomain}/outbox?${params}`;

    logger.info("pullFromRemote: Fetching", {
      remoteDomain,
      from: from.length,
      to: to.length,
      since,
      limit,
      serverOnlyPull,
    });

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/activity+json",
        "User-Agent": `Kowloon/${ourDomain}`,
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      logger.error("pullFromRemote: HTTP error", {
        remoteDomain,
        status: response.status,
        statusText: response.statusText,
        error: errorText,
      });
      return {
        items: [],
        nextCursor: null,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const data = await response.json();
    const items = data.items || data.orderedItems || [];
    const recipients = data.recipients || []; // only used for user follows
    const tombstones = Array.isArray(data.tombstones) ? data.tombstones : [];
    const nextCursor = data.next || null;

    logger.info("pullFromRemote: Retrieved", {
      remoteDomain,
      items: items.length,
      recipientEntries: recipients.length,
      tombstones: tombstones.length,
      serverOnlyPull,
    });

    // Self-heal deletions: the origin told us which of its items were deleted
    // since our last pull. Purge our cached copies (feed presence + any Post
    // shadow) so a deleted post disappears from our users' feeds too.
    if (tombstones.length) {
      try {
        await FeedItems.deleteMany({ id: { $in: tombstones } });
        await FeedFanOut.deleteMany({ feedItemId: { $in: tombstones } });
        await Post.updateMany(
          { id: { $in: tombstones }, deletedAt: null },
          { $set: { deletedAt: new Date(), type: "Tombstone" } }
        );
        logger.info("pullFromRemote: Purged remote tombstones", {
          remoteDomain,
          count: tombstones.length,
        });
      } catch (err) {
        logger.error("pullFromRemote: tombstone purge failed", {
          remoteDomain,
          error: err.message,
        });
      }
    }

    // Upsert all items into local FeedItems.
    // Strip _id and __v — MongoDB rejects $set: { _id } on existing documents even
    // if the value is unchanged, which would silently prevent FanOut from running.
    const upsertedIds = new Set();
    for (const item of items) {
      if (!item.id) {
        logger.warn("pullFromRemote: Item missing ID, skipping", { item });
        continue;
      }
      try {
        const { _id, __v, ...itemFields } = item;
        // Remote items carry publishedAt as an ISO string; coerce to a real Date
        // so it doesn't sort below Date-typed local posts (see schema/FeedItems.js).
        // The typed schema path also casts this, but be explicit at the write site.
        if (itemFields.publishedAt) itemFields.publishedAt = new Date(itemFields.publishedAt);
        await FeedItems.findOneAndUpdate(
          { id: item.id },
          { $set: itemFields },
          { upsert: true, new: true }
        );
        upsertedIds.add(item.id);
      } catch (err) {
        logger.error("pullFromRemote: Upsert failed", {
          remoteDomain,
          itemId: item.id,
          error: err.message,
        });
      }
    }

    logger.info("pullFromRemote: Upserted items", {
      remoteDomain,
      total: items.length,
      upserted: upsertedIds.size,
    });

    // Cache metadata for any remote media these posts reference, so attachment
    // enrichment can resolve mediaType + origin URL (otherwise cross-server
    // images/audio/video are dropped at serve time). Public files only; the
    // helper skips local ids and non-public files. Non-fatal.
    try {
      const remoteFileIds = new Set();
      for (const item of items) {
        const o = item?.object || {};
        for (const v of [o.image, ...(o.attachments || [])]) {
          // Post.attachments is now a resolved {fileId, ...} object on peers
          // that have migrated; other servers deploy independently, so a
          // peer may still send the legacy bare-string shape.
          const fid = typeof v === "string" ? fileIdFromValue(v) : v?.fileId || null;
          if (fid) remoteFileIds.add(fid);
        }
      }
      if (remoteFileIds.size > 0) await hydrateRemoteFiles([...remoteFileIds]);
    } catch (err) {
      logger.warn("pullFromRemote: remote file hydration failed", { remoteDomain, error: err.message });
    }

    if (upsertedIds.size === 0) {
      return { items, nextCursor, error: null };
    }

    // Load FeedItem metadata needed for FanOut rows
    const feedItems = await FeedItems.find({ id: { $in: [...upsertedIds] } }).lean();
    const feedItemMap = new Map();
    for (const fi of feedItems) feedItemMap.set(fi.id, fi);

    // Pre-load each recipient's blocked + muted sets so we can skip FanOut
    // rows for posts by authors they've blocked or muted.
    const blockedByUser = new Map();
    if (to.length > 0) {
      const users = await User.find({ id: { $in: to } }).select("circles").lean();
      await Promise.all(
        users.map(async (user) => {
          const [blockedCircle, mutedCircle] = await Promise.all([
            user.circles?.blocked
              ? Circle.findOne({ id: user.circles.blocked }).select("members").lean()
              : null,
            user.circles?.muted
              ? Circle.findOne({ id: user.circles.muted }).select("members").lean()
              : null,
          ]);
          const denied = new Set([
            ...(blockedCircle?.members || []).map((m) => m.id),
            ...(mutedCircle?.members || []).map((m) => m.id),
          ]);
          blockedByUser.set(user.id, denied);
        })
      );
    }

    let fanOutCount = 0;
    const fanOutOps = [];

    function pushFanOut(itemId, feedItem, userId) {
      if (blockedByUser.get(userId)?.has(feedItem.actorId)) return;
      const hash = dedupeHash(itemId, userId);
      fanOutOps.push({
        updateOne: {
          filter: { dedupeHash: hash },
          update: {
            $setOnInsert: {
              feedItemId: itemId,
              objectType: feedItem.objectType,
              actorId: feedItem.actorId,
              to: userId,
              groupId: null,
              reason: "circle",
              canReply: feedItem.canReply || "public",
              canReact: feedItem.canReact || "public",
              dedupeHash: hash,
            },
          },
          upsert: true,
        },
      });
    }

    if (serverOnlyPull) {
      // Posts are @public. The remote doesn't know who subscribes on our server —
      // we do. Fan out every returned item to every user in `to` (all local
      // subscribers for this server entry).
      for (const itemId of upsertedIds) {
        const feedItem = feedItemMap.get(itemId);
        if (!feedItem) continue;
        for (const userId of to) {
          pushFanOut(itemId, feedItem, userId);
        }
      }
    } else {
      // User follows: the remote computed exact recipients per item (it knows
      // its own circle memberships for circle-addressed posts, and which `to`
      // users follow each author for public posts).
      for (const { itemId, to: recipientIds } of recipients) {
        if (!upsertedIds.has(itemId)) continue;
        const feedItem = feedItemMap.get(itemId);
        if (!feedItem) continue;
        for (const userId of recipientIds) {
          pushFanOut(itemId, feedItem, userId);
        }
      }
    }

    if (fanOutOps.length > 0) {
      try {
        const result = await FeedFanOut.bulkWrite(fanOutOps);
        fanOutCount = result.upsertedCount || 0;

        // Feed nudge (#75): a pull that landed NEW feed content is a fan-out
        // event, so fire "Your feeds have new posts" for the users who got new
        // rows (the remote half — local posts nudge via the Create handler).
        // Keyed off the bulk-write's newly-inserted ops so re-pulls don't
        // re-nudge; one pair per user; throttled/opt-in inside notifyFeedFanOut.
        const seen = new Set();
        const pairs = [];
        for (const idxStr of Object.keys(result.upsertedIds || {})) {
          const set = fanOutOps[Number(idxStr)]?.updateOne?.update?.$setOnInsert;
          if (set?.to && !set.groupId && !seen.has(set.to)) {
            seen.add(set.to);
            pairs.push({ userId: set.to, actorId: set.actorId });
          }
        }
        if (pairs.length) notifyFeedFanOut(pairs).catch(() => {});
      } catch (err) {
        logger.error("pullFromRemote: FeedFanOut bulkWrite failed", {
          remoteDomain,
          error: err.message,
        });
      }
    }

    logger.info("pullFromRemote: Enqueued FeedFanOut entries", {
      remoteDomain,
      fanOutCount,
      serverOnlyPull,
    });

    return { items, nextCursor, error: null };
  } catch (error) {
    logger.error("pullFromRemote: Error", {
      remoteDomain,
      error: error.message,
      stack: error.stack,
    });
    return { items: [], nextCursor: null, error: error.message };
  }
}
