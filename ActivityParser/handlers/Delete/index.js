// /ActivityParser/handlers/Delete/index.js

import {
  Bookmark,
  Circle,
  Group,
  Page,
  Post,
  React as ReactModel,
  Reply,
  User,
  FeedItems,
} from "#schema";
import kowloonId from "#methods/parse/kowloonId.js";
import isServerAdmin from "#methods/auth/isServerAdmin.js";
import getFederationTargetsHelper from "../utils/getFederationTargets.js";
import { getServerSettings } from "#methods/settings/schemaHelpers.js";

// Reply (and React) records have empty `to` by design — visibility inherits
// from the parent — so the generic federation helper returns shouldFederate:
// false. For these we route based on the parent's domain (held in `target`).
function getChildFederationTargets(childObj) {
  const parentId = childObj?.target;
  if (!parentId) return { shouldFederate: false };
  const parsed = kowloonId(parentId);
  const { domain: serverDomain } = getServerSettings();
  if (!parsed.domain || parsed.domain.toLowerCase() === serverDomain?.toLowerCase()) {
    return { shouldFederate: false };
  }
  return { shouldFederate: true, scope: "domain", domains: [parsed.domain] };
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

async function purgeFeedItems(deletedId) {
  try {
    await FeedItems.deleteOne({ id: deletedId });
  } catch (err) {
    console.error(`FeedItems purge failed for ${deletedId}:`, err.message);
  }
}

// Soft-delete every Bookmark or Folder descended from rootFolderId. Owner
// auth is enforced by the caller — here we only touch records the owner
// already owns. Returns the number of records tombstoned.
async function cascadeDeleteFolder(rootFolderId, actorId) {
  let cascadeCount = 0;
  const queue = [rootFolderId];
  const seen = new Set();
  while (queue.length) {
    const parentId = queue.shift();
    if (seen.has(parentId)) continue;
    seen.add(parentId);
    const children = await Bookmark.find({
      parentFolder: parentId,
      actorId,
      deletedAt: null,
    })
      .select("id type")
      .lean();
    for (const child of children) {
      await Bookmark.updateOne(
        { id: child.id },
        {
          $set: {
            deletedAt: new Date(),
            deletedBy: actorId,
            type: "Tombstone",
          },
        }
      );
      cascadeCount += 1;
      if (child.type === "Folder") queue.push(child.id);
    }
  }
  return cascadeCount;
}

/**
 * Type-specific validation for Delete activities
 * Per specification: target REQUIRED (all other fields optional)
 * @param {Object} activity
 * @returns {{ valid: boolean, errors?: string[] }}
 */
export function validate(activity) {
  const errors = [];

  if (!activity?.actorId || typeof activity.actorId !== "string") {
    errors.push("Delete: missing activity.actorId");
  }

  // target may be a string or a non-empty array of strings
  const t = activity?.target;
  if (!t) {
    errors.push("Delete: missing required field 'target' (object ID or array of IDs)");
  } else if (Array.isArray(t)) {
    if (t.length === 0) errors.push("Delete: 'target' array must not be empty");
    else if (t.some((id) => typeof id !== "string"))
      errors.push("Delete: all entries in 'target' array must be strings");
  } else if (typeof t !== "string") {
    errors.push("Delete: 'target' must be a string or array of strings");
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Determine federation targets for Delete activity
 * @param {Object} activity - The activity envelope
 * @param {Object} deleted - The deleted object
 * @returns {Promise<FederationRequirements>}
 */
export async function getFederationTargets(activity, deleted) {
  // Use the common helper based on the deleted object's addressing
  return getFederationTargetsHelper(activity, deleted);
}

async function deleteOne(activity, targetId) {
  const parsed = kowloonId(targetId);
  const Model = MODELS[parsed?.type];
  if (!Model) {
    return { id: targetId, error: `unsupported target type "${parsed?.type}"` };
  }

  const query =
    parsed.type === "URL" ? { url: targetId } : { id: targetId };

  const current =
    (await Model.findOne(query).lean?.()) ?? (await Model.findOne(query));
  if (!current) {
    return { id: targetId, error: `target not found` };
  }

  // System circles (Following, All Following, Groups, Blocked, Muted) are
  // load-bearing pointers on the User doc (user.circles.*) — other code
  // dereferences them assuming they resolve. Deletion is never a valid
  // "reset"; membership can always be cleared instead. No owner/admin
  // exception — this isn't a permission, it's a structural invariant.
  if (parsed.type === "Circle" && current.type === "System") {
    return { id: targetId, error: "System circles cannot be deleted" };
  }

  const ownerActorId = parsed.type === "User" ? current.id : current.actorId;
  const isOwner = activity.actorId === ownerActorId;
  const isAdmin = await isServerAdmin(activity.actorId);
  if (!isOwner && !isAdmin) {
    return { id: targetId, error: "not authorized to delete this object" };
  }

  const tombstoneFields =
    parsed.type === "User"
      ? { deletedAt: new Date(), deletedBy: activity.actorId, active: false }
      : { deletedAt: new Date(), deletedBy: activity.actorId, type: "Tombstone" };

  // Conditional tombstone: only the Delete that actually flips deletedAt
  // from null wins. Two concurrent Deletes used to both read "not deleted"
  // and both decrement counters; now only the winner sees a doc back.
  let deleted = await Model.findOneAndUpdate(
    { ...query, deletedAt: null },
    { $set: tombstoneFields },
    { new: true }
  ).lean();
  const wasAlreadyDeleted = !deleted;
  if (!deleted) deleted = await Model.findOne(query).lean();
  if (!deleted) {
    return { id: targetId, error: `target not found` };
  }

  await purgeFeedItems(deleted.id);

  // Folder cascade: when a Bookmark record of type Folder is tombstoned,
  // recursively tombstone every descendant the same owner owns. Skipped
  // for repeat deletes so re-running can't re-process tombstones.
  let cascadeCount = 0;
  if (
    parsed.type === "Bookmark" &&
    current.type === "Folder" &&
    !wasAlreadyDeleted
  ) {
    cascadeCount = await cascadeDeleteFolder(current.id, activity.actorId);
  }

  // Decrement the author's activity counters on first tombstone only.
  if (!wasAlreadyDeleted && current.actorId) {
    if (parsed.type === "Post") {
      await User.updateOne(
        { id: current.actorId, postCount: { $gt: 0 } },
        { $inc: { postCount: -1 } }
      );
    } else if (parsed.type === "Reply") {
      await User.updateOne(
        { id: current.actorId, replyCount: { $gt: 0 } },
        { $inc: { replyCount: -1 } }
      );
    } else if (parsed.type === "React") {
      await User.updateOne(
        { id: current.actorId, reactCount: { $gt: 0 } },
        { $inc: { reactCount: -1 } }
      );
    }
  }

  // Reply: decrement replyCount on the parent (mirror of Reply handler's bump
  // at create time). Only on the first tombstone so repeat Deletes don't
  // double-decrement.
  if (parsed.type === "Reply" && !wasAlreadyDeleted && current.target) {
    const parentId = current.target;
    const parentCollections = [
      Post?.collection,
      Page?.collection,
      Bookmark?.collection,
      Group?.collection,
      Circle?.collection,
    ];
    for (const col of parentCollections) {
      try {
        if (!col) continue;
        // $gt guard: never drive the count negative (drift is healed by
        // methods/maintenance/recomputeCounters.js).
        const r = await col.updateOne(
          { id: parentId, replyCount: { $gt: 0 } },
          { $inc: { replyCount: -1 } }
        );
        if (r?.modifiedCount > 0) break;
      } catch (e) {
        // ignore model mismatches
      }
    }
    await FeedItems.updateOne(
      { id: parentId, "object.replyCount": { $gt: 0 } },
      { $inc: { "object.replyCount": -1 } }
    );
    // Second-level reply: the Reply handler also bumped the immediate parent
    // reply's own replyCount, so undo that too.
    if (current.parent && current.parent !== parentId) {
      await Reply.collection.updateOne(
        { id: current.parent, replyCount: { $gt: 0 } },
        { $inc: { replyCount: -1 } }
      );
    }
  }

  let resultObj = deleted.toObject ? deleted.toObject() : { ...deleted };
  if (parsed.type === "User") {
    delete resultObj.password;
    delete resultObj.privateKey;
    delete resultObj.publicKeyJwk;
    delete resultObj.signature;
  }

  return {
    id: targetId,
    deleted: resultObj,
    type: parsed.type,
    cascadeCount,
  };
}

export default async function Delete(activity) {
  try {
    const validation = validate(activity);
    if (!validation.valid) {
      return { activity, error: validation.errors.join("; ") };
    }

    const targets = Array.isArray(activity.target)
      ? activity.target
      : [activity.target];

    const results = await Promise.all(targets.map((id) => deleteOne(activity, id)));

    const succeeded = results.filter((r) => r.deleted);
    const failed = results.filter((r) => r.error);

    if (succeeded.length === 0) {
      return { activity, error: failed.map((r) => `${r.id}: ${r.error}`).join("; ") };
    }

    // Use the first successful deletion for federation targeting.
    // Bookmarks are personal-only, never federated.
    const primary = succeeded[0].deleted;
    activity.objectId = primary.id;
    const primaryType = succeeded[0].type || primary.objectType || primary.type;
    const federation = primaryType === "Bookmark"
      ? { shouldFederate: false }
      : primaryType === "Reply" || primaryType === "React"
      ? getChildFederationTargets(primary)
      : await getFederationTargets(activity, primary);

    // Single-target: preserve original response shape for backwards compat
    if (targets.length === 1) {
      return { activity, created: primary, result: primary, federation };
    }

    return {
      activity,
      results: succeeded.map((r) => r.deleted),
      errors: failed.length > 0 ? failed : undefined,
      federation,
    };
  } catch (err) {
    return { activity, error: err?.message || String(err) };
  }
}
