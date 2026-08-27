// #ActivityParser/handlers/Reply/index.js
// Reply is its own model, NOT a Post subtype. This handler is self-contained:
// validates, creates the Reply doc, bumps replyCount on parent, federates if
// remote, and creates a notification for the parent author.

import {
  Reply as ReplyModel,
  Post,
  Page,
  Bookmark,
  Group,
  Circle,
  User,
  FeedItems,
} from "#schema";
import createNotification from "#methods/notifications/create.js";
import notifyMentions from "#methods/mentions/notify.js";
import kowloonId from "#methods/parse/kowloonId.js";
import { getServerSettings } from "#methods/settings/schemaHelpers.js";
import getMultiFederationTargets from "../utils/getMultiFederationTargets.js";
import { authorizeInteraction } from "#methods/feed/visibility.js";
import resolveAttachments from "#methods/files/resolveAttachment.js";

/**
 * Validate Reply activity
 * Required: actorId, objectType ("Reply"), object (with content), to (parent ID)
 */
export function validate(activity) {
  const errors = [];

  if (!activity?.actorId || typeof activity.actorId !== "string") {
    errors.push("Reply: missing activity.actorId");
  }

  if (!activity?.objectType || activity.objectType !== "Reply") {
    errors.push("Reply: objectType must be 'Reply'");
  }

  if (!activity?.object || typeof activity.object !== "object") {
    errors.push("Reply: missing required field 'object'");
  }

  if (!activity?.to || typeof activity.to !== "string") {
    errors.push("Reply: missing required field 'to' (parent object ID)");
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Determine federation targets for Reply activity.
 * Replies federate to the domain of the parent object if it's remote.
 */
export async function getFederationTargets(activity, created) {
  // Route by the ROOT post (created.target), which holds the canonical thread —
  // for a second-level reply that's the post, not the reply that was answered.
  const targetId = created?.target || activity.to;
  if (!targetId) return { shouldFederate: false };

  const parsed = kowloonId(targetId);
  const { domain: serverDomain } = getServerSettings();

  if (!parsed.domain || parsed.domain.toLowerCase() === serverDomain?.toLowerCase()) {
    return { shouldFederate: false };
  }

  return {
    shouldFederate: true,
    scope: "domain",
    domains: [parsed.domain],
  };
}

// Window in which an identical reply from the same actor on the same target is
// treated as a duplicate (5 minutes).
const CONTENT_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

export default async function Reply(activity, ctx = {}) {
  try {
    // 1. Validate
    const validation = validate(activity);
    if (!validation.valid) {
      return { activity, error: validation.errors.join("; ") };
    }

    const actorId = activity.actorId;
    const repliedToId = activity.to; // what the user replied to — a post OR a reply

    // 1b. Resolve two-level threading (Facebook-style: replies to a post, and
    // replies to those, but no deeper).
    //   target = the ROOT post — so GET /posts/:id/replies returns the whole
    //            thread in one query, and federation routes to the post's host.
    //   parent = the immediate parent, but never deeper than a first-level reply:
    //            a reply to a second-level reply flattens onto its level-1
    //            ancestor (so the tree can never exceed depth 2).
    let rootId = repliedToId; // default: replying to a top-level object (a Post)
    let parentId = repliedToId; // default: first-level reply (parent === root)
    let repliedToAuthorId;

    const parentReply = await ReplyModel.findOne({ id: repliedToId })
      .select("actorId target parent")
      .lean();
    if (parentReply) {
      repliedToAuthorId = parentReply.actorId;
      rootId = parentReply.target; // the post the whole thread hangs off
      // If the parent is itself a second-level reply (its parent !== its target),
      // attach the new reply to the level-1 ancestor instead — depth cap at 2.
      const parentIsTopLevel = parentReply.parent === parentReply.target;
      parentId = parentIsTopLevel ? repliedToId : parentReply.parent;
    }

    // 1c. Authorize — visibility, block, and canReply all gate against the
    // ROOT post, matching this codebase's existing rule that a Reply's
    // effective visibility is inherited from the root object, not the
    // immediate parent (see the class doc comment above: Reply.to/canReply/
    // canReact are always blank; the parent is the source of truth). Does
    // NOT separately check the immediate parent reply's author's block list
    // if it differs from the root author's — see kowloon-network/kowloon#40.
    const authz = await authorizeInteraction({
      actorId,
      targetId: rootId,
      capability: "canReply",
    });
    if (!authz.ok) {
      return { activity, error: authz.message, status: authz.status };
    }

    // 1d. Content-based dedup — same actor, same content, same immediate parent
    // within the window is a duplicate. Returns the existing reply rather than
    // creating a new one. Prevents spam-clicking the submit button (network-retry
    // idempotency is handled separately via `dedupeKey`).
    const submittedContent =
      activity.object?.source?.content ?? activity.object?.content;
    if (typeof submittedContent === "string" && submittedContent.trim()) {
      const since = new Date(Date.now() - CONTENT_DEDUPE_WINDOW_MS);
      const existing = await ReplyModel.findOne({
        actorId,
        parent: parentId,
        "source.content": submittedContent,
        createdAt: { $gte: since },
      }).lean();
      if (existing) {
        activity.objectId = existing.id;
        return {
          activity,
          created: existing,
          duplicated: true,
          federation: { shouldFederate: false },
        };
      }
    }

    // 2. Build the Reply document
    const replyData = {
      actorId,
      actor: activity.actor || {},
      target: rootId,
      parent: parentId,
      to: "",
      canReply: "",
      canReact: "",
      source: {},
    };

    // Content: accept object.content or object.source.content
    if (activity.object.source?.content) {
      replyData.source = { ...activity.object.source };
    } else if (activity.object.content) {
      replyData.source.content = activity.object.content;
    }

    if (!replyData.source.mediaType) {
      replyData.source.mediaType = "text/markdown";
    }

    if (activity.object.attachments) {
      replyData.attachments = await resolveAttachments(activity.object.attachments);
    }

    // 3. Create the Reply
    const created = await ReplyModel.create(replyData);
    activity.objectId = created.id;

    // Track reply count on the author's User record
    await User.updateOne({ id: actorId }, { $inc: { replyCount: 1 } });

    // 4. Bump replyCount on the ROOT post (total thread size) + its FeedItems.
    // Use raw collection driver to bypass all Mongoose middleware/hooks.
    const collections = [
      Post?.collection,
      Page?.collection,
      Bookmark?.collection,
      Group?.collection,
      Circle?.collection,
    ];
    for (const col of collections) {
      try {
        if (!col) continue;
        const r = await col.updateOne({ id: rootId }, { $inc: { replyCount: 1 } });
        if (r?.modifiedCount > 0) break;
      } catch (e) {
        // ignore model mismatches
      }
    }
    // Keep FeedItems in sync so getPost returns the updated count immediately
    await FeedItems.updateOne({ id: rootId }, { $inc: { "object.replyCount": 1 } });
    // For a second-level reply, also bump the first-level parent reply's own
    // replyCount (drives its "N replies" affordance).
    if (parentId !== rootId) {
      try {
        await ReplyModel.collection.updateOne(
          { id: parentId },
          { $inc: { replyCount: 1 } }
        );
      } catch (e) {
        // ignore
      }
    }

    // 5. Notify the author of the thing that was actually replied to (the
    // immediate parent — post or first-level reply), routing to the root post.
    let notifyAuthorId = repliedToAuthorId;
    if (!notifyAuthorId) {
      for (const Model of [Post, Page, Bookmark, Group]) {
        try {
          if (!Model) continue;
          const p = await Model.findOne({ id: repliedToId }).select("actorId").lean();
          if (p?.actorId) {
            notifyAuthorId = p.actorId;
            break;
          }
        } catch (e) {
          // Continue to next model
        }
      }
    }

    try {
      if (notifyAuthorId && notifyAuthorId !== actorId) {
        const recipient = await User.findOne({ id: notifyAuthorId })
          .select("prefs")
          .lean();
        const wantsNotification =
          recipient?.prefs?.notifications?.reply !== false;

        if (wantsNotification) {
          await createNotification({
            type: "reply",
            recipientId: notifyAuthorId,
            actorId,
            objectId: rootId,
            objectType: "Post",
            activityId: activity.id,
            activityType: "Reply",
            groupKey: `reply:${rootId}`,
          });
        }
      }
    } catch (err) {
      console.error("Failed to create notification for Reply:", err.message);
      // Non-fatal
    }

    // Mentions in the reply body — notify local users tagged @user@domain
    // (this is the more common case: tagging someone into a thread).
    notifyMentions({
      content: created.source?.content,
      actorId,
      actorName: created.actor?.name,
      objectId: created.id,
      objectType: "Reply",
    }).catch(() => {});

    // 6. Federation — the root post's host holds the canonical aggregate; also
    // the replied-to author's home for the notification side-effect.
    const createdObj = created.toObject ? created.toObject() : created;
    const federation = getMultiFederationTargets(rootId, notifyAuthorId);

    return {
      activity,
      created: createdObj,
      federation,
    };
  } catch (err) {
    return { activity, error: err?.message || String(err) };
  }
}
