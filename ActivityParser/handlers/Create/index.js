// /ActivityParser/handlers/Create/index.js

import {
  Bookmark,
  Circle,
  Group,
  Page,
  Post,
  React as ReactModel,
  Reply,
  User,
  Settings,
  FeedItems, // <- ensure Settings is exported from #schema/index.js
  File,
} from "#schema";
import { getServerSettings, getServerActor } from "#methods/settings/schemaHelpers.js";
import kowloonId from "#methods/parse/kowloonId.js";
import { canonicalAudience } from "#methods/parse/canonicalTo.js";
import getFederationTargetsHelper from "../utils/getFederationTargets.js";
import createNotification from "#methods/notifications/create.js";
import regenerateCircleIcon from "#methods/circles/regenerateCircleIcon.js";
import notifyFeedActivity from "#methods/notifications/notifyFeedActivity.js";
import notifyMentions from "#methods/mentions/notify.js";
import writeFeedItems from "#methods/feed/writeFeedItems.js";
import sanitizeHtml from "#methods/utils/sanitize.js";
import resolveAttachments from "#methods/files/resolveAttachment.js";

// Strip dangerous HTML tags from Markdown source while preserving:
//   1. Markdown syntax — sanitize-html encodes stray > chars to &gt;, which
//      breaks "> blockquote" syntax. We decode entities back after stripping.
//   2. <u> and <s> inline HTML — tiptap-markdown emits these for marks that
//      have no Markdown equivalent (underline, strikethrough). Full XSS
//      sanitization runs in safeMarkdown() at render time via ALLOWED_TAGS.
function stripHtmlFromMarkdown(text) {
  if (typeof text !== "string") return text;
  const stripped = sanitizeHtml(text, {
    allowedTags: ["u", "s"],
    allowedAttributes: {},
  });
  return stripped
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

const MODELS = {
  Bookmark,
  Circle,
  Group,
  Page,
  Post,
  React: ReactModel,
  Reply,
  User,
};


/**
 * Create notifications for relevant activities
 * - Reply: Notify the author of the post being replied to (if they have it enabled)
 */
async function createNotifications(activity, created, objectType) {
  try {
    // Only create notifications for Post types (Reply handles its own notifications)
    if (objectType !== "Post") return;

    // Feed / group "new posts" nudges — throttled (12h) + opt-in. Fire-and-
    // forget so it never blocks or breaks the post. Covers local posts; remote
    // followed-user posts (federation pull) are a follow-on.
    notifyFeedActivity(created).catch(() => {});

    // Mentions — notify any LOCAL users tagged @user@domain in the body. Remote
    // handles are linked but not notified. Fire-and-forget, opt-out via prefs.
    notifyMentions({
      content: created.source?.content,
      actorId: activity.actorId,
      actorName: created.actor?.name,
      objectId: created.id,
      objectType: "Post",
    }).catch(() => {});

    // Check if this Post has inReplyTo (shouldn't happen now that Reply is separate)
    if (created.inReplyTo) {
      const originalPost = await Post.findOne({ id: created.inReplyTo }).lean();

      if (originalPost && originalPost.actorId) {
        // Check if user wants reply notifications (default true)
        const recipient = await User.findOne({ id: originalPost.actorId }).select("prefs").lean();
        const wantsNotification = recipient?.prefs?.notifications?.reply !== false;

        if (wantsNotification) {
          await createNotification({
            type: "reply",
            recipientId: originalPost.actorId,
            actorId: activity.actorId,
            objectId: created.id,
            objectType: "Reply",
            activityId: activity.id,
            activityType: "Create",
            groupKey: `reply:${originalPost.id}`,
          });
        }
      }
    }
  } catch (err) {
    console.error("Failed to create notifications for Create activity:", err.message);
    // Non-fatal: don't block object creation if notification fails
  }
}

/**
 * Type-specific validation for Create activities
 * Per specification: objectType, object, to, canReply, canReact are REQUIRED
 * @param {Object} activity
 * @returns {{ valid: boolean, errors?: string[] }}
 */
export function validate(activity) {
  const errors = [];

  // Required: objectType
  const type = activity?.objectType;
  if (!type || typeof type !== "string") {
    errors.push("Create: missing required field 'objectType'");
  }

  if (type && !MODELS[type]) {
    errors.push(`Create: unsupported objectType "${type}"`);
  }

  // Required: object
  if (!activity?.object || typeof activity.object !== "object") {
    errors.push("Create: missing required field 'object'");
  }

  // Required: to
  if (!activity?.to || typeof activity.to !== "string") {
    errors.push("Create: missing required field 'to'");
  }

  // Required: canReply
  if (activity?.canReply === undefined) {
    errors.push("Create: missing required field 'canReply'");
  }

  // Required: canReact
  if (activity?.canReact === undefined) {
    errors.push("Create: missing required field 'canReact'");
  }

  // Additional validation for User creation
  if (type === "User") {
    const obj = activity.object;
    const hasPassword = obj?.password || obj?.pass;
    if (!hasPassword) {
      errors.push("Create User: password is required");
    }

    const username = obj?.username;
    const actorIdFromObject = obj?.actorId || obj?.id;
    if (!username && !actorIdFromObject) {
      errors.push("Create User: username or actorId is required");
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Determine federation targets for Create activity
 * @param {Object} activity - The activity envelope
 * @param {Object} created - The created object
 * @returns {Promise<FederationRequirements>}
 */
export async function getFederationTargets(activity, created) {
  // Users don't federate via Create (they're discovered via webfinger)
  if (activity.objectType === "User") {
    return { shouldFederate: false };
  }

  // Use the common helper based on the created object's addressing
  return getFederationTargetsHelper(activity, created);
}

export default async function Create(activity) {
  try {
    // 1. Validate
    const validation = validate(activity);
    if (!validation.valid) {
      return { activity, error: validation.errors.join("; ") };
    }

    const type = activity.objectType;
    const Model = MODELS[type];

    // ---- Special handling for Create → User --------------------------------
    if (type === "User") {
      const obj = { ...activity.object };

      // Accept either password or legacy "pass" field; normalize to "password"
      if (obj.pass && !obj.password) obj.password = obj.pass;
      delete obj.pass;

      // We need a username. If actorId is present, derive username from it.
      let username = obj.username;
      let actorIdFromObject = obj.actorId || obj.id; // activity requires object.actorId, but model uses "id"
      if (
        !username &&
        actorIdFromObject &&
        typeof actorIdFromObject === "string"
      ) {
        // supports "@user@domain" and plain "user@domain"
        const handle = actorIdFromObject.startsWith("@")
          ? actorIdFromObject.slice(1)
          : actorIdFromObject;
        username = handle.split("@")[0];
      }

      if (!username || typeof username !== "string") {
        return {
          activity,
          error:
            "Create User: 'username' (or object.actorId with username) is required",
        };
      }

      // Ensure the model "id" field (actor handle) is set consistently
      // If object.actorId is provided, prefer it; otherwise mint from settings.domain
      let actorId = actorIdFromObject;
      if (!actorId) {
        const domainSetting = await Settings.findOne({ name: "domain" }).lean();
        const domain = domainSetting?.value;
        if (!domain) {
          return {
            activity,
            error: "Create User: cannot mint actorId (missing Settings.domain)",
          };
        }
        actorId = `@${username}@${domain}`;
      }
      // Map to schema field "id" (User schema treats `id` as the actor handle)
      obj.id = actorId;

      // The rest (inbox/outbox/url/server/keys) is handled by UserSchema.pre('save')
      const created = await User.create(obj);

      activity.objectId = created.id;

      // Users typically don't go into FeedItems (not timeline objects)
      // but you could add them if needed

      return { activity, created };
    } else {
      // For everything but User, ensure actorId is set on the object
      if (!activity.object.actorId) {
        activity.object.actorId = activity.actorId;
      }

      // Resolve actor profile: use what the client sent, fall back to DB lookup
      const clientActor = activity.actor && activity.actor.id ? activity.actor : null;
      if (clientActor) {
        activity.object.actor = clientActor;
      } else if (activity.actorId) {
        const { actorId: serverActorId, domain } = getServerSettings();
        if (activity.actorId === serverActorId) {
          activity.object.actor = getServerActor();
        } else {
          const actorDoc = await User.findOne({ id: activity.actorId })
            .select("id username profile url inbox outbox server actorId")
            .lean();
          if (actorDoc) {
            activity.object.actor = {
              id: actorDoc.id,
              type: actorDoc.type ?? 'Person',
              name: actorDoc.profile?.name ?? actorDoc.username,
              icon: actorDoc.profile?.icon ?? null,
              url: actorDoc.url ?? `https://${domain}/users/${actorDoc.id}`,
              inbox: actorDoc.inbox,
              outbox: actorDoc.outbox,
              server: actorDoc.server ?? `@${domain}`,
            };
          } else {
            activity.object.actor = {};
          }
        }
      }
    }

    // ---- Generic path for other object types -------------------------------
    // Transform content field for Post/Reply types
    // Post/Reply schemas expect source.content, but ActivityStreams uses top-level content
    if ((type === "Post" || type === "Reply") && activity.object.content) {
      if (!activity.object.source) {
        activity.object.source = {};
      }
      // Only move content to source if source.content isn't already set
      if (!activity.object.source.content) {
        activity.object.source.content = activity.object.content;
      }
      // Keep the top-level content for compatibility
    }

    // Set Post/Reply source defaults and enforce markdown-only policy.
    // Regardless of what a client sends, mediaType is always text/markdown.
    // Raw HTML tags in the content are stripped here so nothing reaches
    // generateBody (or the federated payload) with injected HTML.
    if (type === "Post" || type === "Reply") {
      if (!activity.object.source) {
        activity.object.source = {};
      }
      activity.object.source.mediaType = "text/markdown";
      if (activity.object.source.content) {
        activity.object.source.content = stripHtmlFromMarkdown(activity.object.source.content);
      }
      if (activity.object.content) {
        activity.object.content = stripHtmlFromMarkdown(activity.object.content);
      }
      if (!activity.object.source.contentEncoding) {
        activity.object.source.contentEncoding = "utf-8";
      }
      if (!activity.object.source.language) {
        activity.object.source.language = "en";
      }
    }

    // Copy addressing from activity level to object level if not already set
    // ActivityStreams uses activity.to/canReply/canReact, but our models store them on the object
    if (activity.to !== undefined && (!activity.object.to || activity.object.to === "")) {
      activity.object.to = activity.to;
    }
    if (activity.canReply !== undefined && (!activity.object.canReply || activity.object.canReply === "")) {
      activity.object.canReply = activity.canReply;
    }
    if (activity.canReact !== undefined && (!activity.object.canReact || activity.object.canReact === "")) {
      activity.object.canReact = activity.canReact;
    }

    // Normalize addressing to the canonical scheme (@public, @<domain>, circle:…,
    // group:…, @<owner>@<domain>). Coerces loose values ("public", "server", "",
    // "true") without widening private/circle/group audiences. Owner-scoped types
    // (Circle) default a blank `to` to the owner; the rest default to @public.
    if (["Post", "Circle", "Group", "User"].includes(type)) {
      const toFallback =
        type === "Circle" && activity.actorId ? activity.actorId : "@public";
      const norm = canonicalAudience(
        {
          to: activity.object.to,
          canReply: activity.object.canReply,
          canReact: activity.object.canReact,
        },
        { toFallback }
      );
      activity.object.to = norm.to;
      if (norm.canReply !== undefined) activity.object.canReply = norm.canReply;
      if (norm.canReact !== undefined) activity.object.canReact = norm.canReact;

      // Circles: canReply/canReact aren't independently meaningful yet (kept
      // on the schema for a possible future circle-comments feature) — force
      // them to mirror `to` regardless of what was sent, same as Update.
      if (type === "Circle") {
        activity.object.canReply = activity.object.to;
        activity.object.canReact = activity.object.to;
      }
    }

    // Normalize location to GeoPoint format
    if (activity.object.location) {
      const loc = activity.object.location;
      if (typeof loc === "string") {
        // Plain string — name only, no coordinates
        activity.object.location = { name: loc, type: "Point", coordinates: [0, 0] };
      } else if (typeof loc.lat === "number" && typeof loc.lon === "number") {
        // { lat, lon } (+ optional name) — the web composer tags it type:"Place",
        // mobile sends it bare. Either way, convert to GeoJSON. Requiring
        // type==="Place" left mobile's { name, lat, lon } unnormalized, so it
        // failed GeoPoint validation with "invalid coordinates" (#55, #53).
        activity.object.location = {
          name: loc.name || "",
          type: "Point",
          coordinates: [loc.lon, loc.lat], // GeoJSON: [longitude, latitude]
        };
      }
      // Already-valid GeoPoint objects (type:"Point", coordinates:[lng,lat]) pass through unchanged
    }

    // Map featuredImage → image for Post/Reply/Page schemas (schema field is 'image')
    if (activity.object.featuredImage && !activity.object.image) {
      activity.object.image = activity.object.featuredImage;
    }
    delete activity.object.featuredImage;

    // Bookmark-specific normalization
    if (type === 'Bookmark') {
      // Map parentId → parentFolder (client compat)
      if (activity.object.parentId && !activity.object.parentFolder) {
        activity.object.parentFolder = activity.object.parentId;
      }
      delete activity.object.parentId;

      // Enforce max folder depth of 2 (folders and subfolders only)
      if (activity.object.type === 'Folder' && activity.object.parentFolder) {
        const parent = await Bookmark.findOne({ id: activity.object.parentFolder })
          .select('parentFolder type').lean();
        if (!parent) {
          return { activity, error: 'Bookmark: parent folder not found' };
        }
        if (parent.parentFolder) {
          return { activity, error: 'Bookmark: maximum folder depth (2 levels) exceeded' };
        }
      }
    }

    // Normalize attachments: client sends [{fileId, title, alt}] (or legacy
    // bare strings); Post AND Page (issue #52) store the fully-resolved
    // Attachment subdocument shape. Reply is created via its own
    // self-contained handler (ActivityParser/handlers/Reply/index.js), not
    // this generic path, so it's not handled here.
    if ((type === "Post" || type === "Page") && Array.isArray(activity.object.attachments) && activity.object.attachments.length > 0) {
      activity.object.attachments = await resolveAttachments(activity.object.attachments);
    }

    // Map Event startTime/endTime → event.startDate/event.endDate for Post schema
    if (type === "Post" && activity.object.type === "Event") {
      if (!activity.object.event) activity.object.event = {};
      if (activity.object.startTime && !activity.object.event.startDate) {
        activity.object.event.startDate = activity.object.startTime;
      }
      if (activity.object.endTime && !activity.object.event.endDate) {
        activity.object.event.endDate = activity.object.endTime;
      }
      delete activity.object.startTime;
      delete activity.object.endTime;
    }

    // Preserve original ID for federated objects so they're findable by remote ID across servers.
    // The pre-save hook uses `this.id = this.id || ...` so setting it here is safe.
    if (activity.federated && activity.objectId && !activity.object.id) {
      activity.object.id = activity.objectId;
    }

    // Link posts sharing another Kowloon post (issue #44): credit the
    // ORIGINAL author. Resolved server-side from FeedItems — the universal
    // read-cache for anything the sharer could have viewed, local or remote
    // (the local Post collection only has rows for local content) — rather
    // than trusted from the client. targetActor asserts a fact about a THIRD
    // PARTY, unlike Post.actor's client-trusted self-embed, so it must never
    // be client-suppliable. Best-effort: a target that no longer resolves
    // (deleted, never cached) just creates the Link post without a credit.
    if (type === "Post" && activity.object.type === "Link") {
      delete activity.object.targetActor;
      if (activity.object.target) {
        try {
          const targetItem = await FeedItems.findOne({ id: activity.object.target })
            .select("object")
            .lean();
          if (targetItem?.object?.actor) {
            activity.object.targetActor = targetItem.object.actor;
          }
        } catch {
          // non-fatal — see comment above
        }
      }
    }

    // If object.actorId is missing, many models will tolerate it, but your
    // outbox added a fallback already. We leave it as-is here.
    let created;
    try {
      created = await Model.create(activity.object);
    } catch (err) {
      // Idempotency backstop (#30): the unique index on `id` rejects a
      // double-write of the same object. Treat that as "already created" and
      // return the existing doc rather than surfacing a duplicate-key error.
      if (err?.code === 11000 && err?.keyValue?.id) {
        const existing = await Model.findOne({ id: err.keyValue.id });
        if (existing) created = existing;
        else throw err;
      } else {
        throw err;
      }
    }

    activity.objectId = created.id;

    // Reload the document to ensure all pre-save hook fields are populated
    // (especially id, url, server which are computed in pre-save)
    // For Groups, we must refetch since pre-save creates circles and those IDs
    // aren't reflected in the returned document
    if (type === "Group") {
      const refetched = await Model.findOne({ id: created.id }).lean();
      if (refetched) created = refetched;

      // Mirror the Join handler: add the new group to the creator's Groups
      // system circle so it appears in their "My Groups" list. Pre-save
      // already seeded them into the group's admins/moderators/members
      // circles, but those track membership of *the group* — the user's own
      // circles.groups is the source of truth for "groups I belong to."
      try {
        const u = await User.findOne({ id: created.actorId }).lean();
        if (u?.circles?.groups) {
          const groupMember = {
            id: created.id,
            name: created.name || "",
            icon: created.icon || "",
            url: created.url || "",
            inbox: created.inbox || "",
            outbox: created.outbox || "",
            server: created.server || "",
          };
          await Circle.updateOne(
            { id: u.circles.groups, "members.id": { $ne: created.id } },
            { $push: { members: groupMember }, $inc: { memberCount: 1 } }
          );
        }
      } catch (_) {
        /* non-fatal — visible in Browse, just missing from My Groups */
      }
    } else {
      // Convert to plain object to access all fields including virtuals
      created = created.toObject ? created.toObject() : created;
    }

    // Back-link any referenced files to this object so File.parentObject
    // resolves visibility correctly at serve time. Only set parentObject if
    // the file doesn't already have one (don't override an earlier link).
    {
      const fileIds = new Set();
      if (typeof activity.object.image === "string" && activity.object.image.startsWith("file:")) {
        fileIds.add(activity.object.image);
      }
      if (Array.isArray(activity.object.attachments)) {
        for (const a of activity.object.attachments) {
          if (typeof a === "string" && a.startsWith("file:")) fileIds.add(a);
          else if (a?.fileId) fileIds.add(a.fileId);
        }
      }
      if (fileIds.size > 0) {
        await File.updateMany(
          { id: { $in: [...fileIds] }, $or: [{ parentObject: { $exists: false } }, { parentObject: null }] },
          { $set: { parentObject: created.id } },
        );
      }
    }

    // Write to FeedItems for timeline delivery
    await writeFeedItems(created, type);

    // User Circles: (re)generate the auto member-avatar mosaic icon now that
    // the circle and its members exist. Fire-and-forget; self-guards on
    // eligibility (skips creator-supplied icons, System circles, remotes).
    if (type === "Circle") {
      regenerateCircleIcon(created.id).catch(() => {});
    }

    // Track post count on the author's User record for directory ranking
    if (type === "Post" && created.actorId) {
      await User.updateOne({ id: created.actorId }, { $inc: { postCount: 1 } });
    }

    // Create notifications for relevant activities
    await createNotifications(activity, created, type);

    // Fire-and-forget: proxy any external og:image URL on Posts into local file storage.
    // This prevents broken images if the source site removes or moves the image.
    if (type === 'Post' && created.image?.startsWith('http')) {
      import('#methods/files/proxyExternalImage.js')
        .then(({ default: proxyExternalImage }) =>
          proxyExternalImage({ url: created.image, actorId: created.actorId, postId: created.id })
        )
        .catch(() => {}); // truly non-fatal
    }

    // 3. Determine federation requirements.
    // Bookmarks are personal utility — they do not federate. Users who
    // want to broadcast a URL post a Link instead.
    const federation = type === "Bookmark"
      ? { shouldFederate: false }
      : await getFederationTargets(activity, created);

    return {
      activity,
      created,
      federation,
    };
  } catch (err) {
    // Surface useful info for E11000 etc.
    const payload = {
      message: err?.message || String(err),
    };
    if (err?.code) payload.code = err.code;
    if (err?.keyValue) payload.keyValue = err.keyValue;

    return { activity, error: payload.message, result: payload };
  }
}
