// /methods/feed/enqueueFanOut.js
// Creates FeedFanOut records for timeline queries
//
// Record types:
// - Public post: ONE record with to: "@public"
// - Server post: ONE record with to: "@server"
// - Circle post: N records (one per member) with to: <member actorId>
// - Public Group post: ONE record with to: "@public", groupId set
// - Private Group post: N records per member, groupId set
// - Reply: inherits addressing from parent (handled by caller)

import crypto from "crypto";
import { FeedFanOut, Circle, Group, User } from "#schema";
import { getServerSettings } from "#methods/settings/schemaHelpers.js";

/**
 * Generate a dedupe hash
 * @param {string} feedItemId - The FeedItems ID
 * @param {string} to - The audience value
 * @returns {string}
 */
function generateDedupeHash(feedItemId, to) {
  return crypto
    .createHash("sha256")
    .update(`${feedItemId}:${to}`)
    .digest("hex");
}

/**
 * Parse the "to" field to determine audience type
 * @param {string} to - Audience "to" field
 * @returns {Object} { type: 'public'|'server'|'circle'|'group', ids: string[] }
 */
function parseAudience(to) {
  if (!to) return { type: "public", ids: [] };

  const { domain, actorId: serverActorId } = getServerSettings();
  const lower = to.toLowerCase().trim();

  // Check for public
  if (lower === "@public" || lower === "public") {
    return { type: "public", ids: [] };
  }

  // Check for server
  if (lower === "@server" || lower === "server" || lower === `@${domain}`) {
    return { type: "server", ids: [] };
  }

  // Parse tokens for Circle/Group IDs
  const tokens = to.split(/\s+/).filter(Boolean);
  const localDomain = domain?.toLowerCase();

  const circleIds = [];
  const groupIds = [];

  for (const token of tokens) {
    // Check if it's a local ID
    const [, domainPart] = token.split("@");
    if (domainPart?.toLowerCase() !== localDomain) continue;

    if (token.startsWith("circle:")) {
      circleIds.push(token);
    } else if (token.startsWith("group:")) {
      groupIds.push(token);
    }
  }

  if (circleIds.length > 0) {
    return { type: "circle", ids: circleIds };
  }

  if (groupIds.length > 0) {
    return { type: "group", ids: groupIds };
  }

  // Check for remote group (group from another server) — fan out to local members
  for (const token of tokens) {
    if (token.startsWith("group:")) {
      return { type: "remote-group", ids: [token] };
    }
  }

  // Unrecognized addressing — skip fan-out rather than expose publicly
  return { type: "invalid", ids: [] };
}

/**
 * Create FeedFanOut records for a post
 *
 * @param {Object} options
 * @param {string} options.feedItemId - The FeedItems.id
 * @param {string} options.objectType - The object type (Post/Reply/Page/etc)
 * @param {string} options.actorId - The author/creator
 * @param {Object} options.audience - Audience snapshot { to, canReply, canReact }
 * @returns {Promise<Object>} Summary of created records
 */
export default async function enqueueFeedFanOut({
  feedItemId,
  feedCacheId, // deprecated, use feedItemId
  objectType,
  actorId,
  audience = {},
}) {
  const itemId = feedItemId || feedCacheId;

  if (!itemId || !objectType || !actorId) {
    throw new Error(
      "enqueueFeedFanOut requires feedItemId, objectType, and actorId"
    );
  }

  const { to, canReply, canReact } = audience;
  const { domain } = getServerSettings();
  const parsed = parseAudience(to);

  const operations = [];

  // PUBLIC: One record with to: "@public"
  if (parsed.type === "public") {
    operations.push({
      updateOne: {
        filter: { dedupeHash: generateDedupeHash(itemId, "@public") },
        update: {
          $setOnInsert: {
            feedItemId: itemId,
            objectType,
            actorId,
            to: "@public",
            groupId: null,
            reason: "public",
            canReply: canReply || "public",
            canReact: canReact || "public",
            dedupeHash: generateDedupeHash(itemId, "@public"),
          },
        },
        upsert: true,
      },
    });
  }

  // SERVER: One record with to: "@server"
  else if (parsed.type === "server") {
    operations.push({
      updateOne: {
        filter: { dedupeHash: generateDedupeHash(itemId, "@server") },
        update: {
          $setOnInsert: {
            feedItemId: itemId,
            objectType,
            actorId,
            to: "@server",
            groupId: null,
            reason: "server",
            canReply: canReply || "public",
            canReact: canReact || "public",
            dedupeHash: generateDedupeHash(itemId, "@server"),
          },
        },
        upsert: true,
      },
    });
  }

  // CIRCLE: N records (one per member)
  else if (parsed.type === "circle") {
    const circles = await Circle.find({ id: { $in: parsed.ids } }).lean();

    const memberIds = new Set();
    for (const circle of circles) {
      for (const member of circle.members || []) {
        if (member.id) memberIds.add(member.id);
      }
    }

    // Add author
    const isLocalAuthor = actorId?.toLowerCase().endsWith(`@${domain?.toLowerCase()}`);
    if (isLocalAuthor) memberIds.add(actorId);

    for (const memberId of memberIds) {
      operations.push({
        updateOne: {
          filter: { dedupeHash: generateDedupeHash(itemId, memberId) },
          update: {
            $setOnInsert: {
              feedItemId: itemId,
              objectType,
              actorId,
              to: memberId,
              groupId: null,
              reason: "circle",
              canReply: canReply || "public",
              canReact: canReact || "public",
              dedupeHash: generateDedupeHash(itemId, memberId),
            },
          },
          upsert: true,
        },
      });
    }
  }

  // GROUP: Depends on group visibility
  else if (parsed.type === "group") {
    const groups = await Group.find({ id: { $in: parsed.ids } }).lean();

    for (const group of groups) {
      const groupTo = group.to?.toLowerCase();
      const isPublicGroup = !groupTo || groupTo === "@public" || groupTo === "public";
      const isServerGroup = groupTo === "@server" || groupTo === "server" || groupTo === `@${domain}`;

      if (isPublicGroup) {
        // Public group: ONE record with to: "@public", groupId set
        operations.push({
          updateOne: {
            filter: { dedupeHash: generateDedupeHash(itemId, `@public:${group.id}`) },
            update: {
              $setOnInsert: {
                feedItemId: itemId,
                objectType,
                actorId,
                to: "@public",
                groupId: group.id,
                reason: "group",
                canReply: canReply || "public",
                canReact: canReact || "public",
                dedupeHash: generateDedupeHash(itemId, `@public:${group.id}`),
              },
            },
            upsert: true,
          },
        });
      } else if (isServerGroup) {
        // Server group: ONE record with to: "@server", groupId set
        operations.push({
          updateOne: {
            filter: { dedupeHash: generateDedupeHash(itemId, `@server:${group.id}`) },
            update: {
              $setOnInsert: {
                feedItemId: itemId,
                objectType,
                actorId,
                to: "@server",
                groupId: group.id,
                reason: "group",
                canReply: canReply || "public",
                canReact: canReact || "public",
                dedupeHash: generateDedupeHash(itemId, `@server:${group.id}`),
              },
            },
            upsert: true,
          },
        });
      } else {
        // Private group: N records per member
        // Group has no top-level `members` -- they live in the Circle at
        // group.circles.members. Reading group.members fanned out to nobody
        // but the author.
        const memberIds = new Set();
        const membersCircle = group.circles?.members
          ? await Circle.findOne({ id: group.circles.members }).select("members.id").lean()
          : null;
        for (const member of membersCircle?.members || []) {
          if (member.id) memberIds.add(member.id);
        }

        // Add author
        const isLocalAuthor = actorId?.toLowerCase().endsWith(`@${domain?.toLowerCase()}`);
        if (isLocalAuthor) memberIds.add(actorId);

        for (const memberId of memberIds) {
          operations.push({
            updateOne: {
              filter: { dedupeHash: generateDedupeHash(itemId, `${memberId}:${group.id}`) },
              update: {
                $setOnInsert: {
                  feedItemId: itemId,
                  objectType,
                  actorId,
                  to: memberId,
                  groupId: group.id,
                  reason: "group",
                  canReply: canReply || "public",
                  canReact: canReact || "public",
                  dedupeHash: generateDedupeHash(itemId, `${memberId}:${group.id}`),
                },
              },
              upsert: true,
            },
          });
        }
      }
    }
  }

  // REMOTE-GROUP: find local users who joined this remote group and create per-user records
  else if (parsed.type === "remote-group") {
    for (const groupId of parsed.ids) {
      // Find all user Groups circles that contain this remote group as a member
      const groupsCircles = await Circle.find({ "members.id": groupId }).select("id").lean();
      if (!groupsCircles.length) continue;

      const circleIds = groupsCircles.map((c) => c.id);
      const localUsers = await User.find({ "circles.groups": { $in: circleIds } })
        .select("id")
        .lean();

      for (const user of localUsers) {
        operations.push({
          updateOne: {
            filter: { dedupeHash: generateDedupeHash(itemId, `${user.id}:${groupId}`) },
            update: {
              $setOnInsert: {
                feedItemId: itemId,
                objectType,
                actorId,
                to: user.id,
                groupId,
                reason: "remote-group",
                canReply: canReply || "public",
                canReact: canReact || "public",
                dedupeHash: generateDedupeHash(itemId, `${user.id}:${groupId}`),
              },
            },
            upsert: true,
          },
        });
      }
    }
  }

  if (parsed.type === "invalid") {
    console.warn(`enqueueFeedFanOut: unrecognized 'to' value "${to}" for ${itemId} — skipping fan-out`);
    return { created: 0, total: 0 };
  }

  if (operations.length === 0) {
    console.log(`No FeedFanOut records to create for: ${itemId}`);
    return { created: 0, total: 0 };
  }

  // Bulk upsert (idempotent)
  const result = await FeedFanOut.bulkWrite(operations);
  const created = result.upsertedCount || 0;

  console.log(`FeedFanOut for ${itemId}: ${created} created, ${operations.length - created} existing`, {
    type: parsed.type,
    objectType,
    actorId,
  });

  return {
    created,
    existing: operations.length - created,
    total: operations.length,
  };
}
