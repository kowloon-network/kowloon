// Leave: actor exits a Group they're part of.
// Group: remove from Members (and Invited, if present).
// Idempotent; records which circles were touched in sideEffects.

import { Group, Circle, User } from "#schema";
import getFederationTargetsHelper from "../utils/getFederationTargets.js";
import kowloonId from "#methods/parse/kowloonId.js";
import isLocalDomain from "#methods/parse/isLocalDomain.js";

/**
 * Type-specific validation for Leave activities
 * Per specification: target (Group ID) is REQUIRED
 * @param {Object} activity
 * @returns {{ valid: boolean, errors?: string[] }}
 */
export function validate(activity) {
  const errors = [];

  if (!activity?.actorId || typeof activity.actorId !== "string") {
    errors.push("Leave: missing activity.actorId");
  }

  // Required: target (Group ID)
  if (!activity?.target || typeof activity.target !== "string") {
    errors.push("Leave: missing required field 'target' (Group ID)");
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Determine federation targets for Leave activity
 * @param {Object} activity - The activity envelope
 * @param {Object} result - The leave result
 * @returns {Promise<FederationRequirements>}
 */
export async function getFederationTargets(activity, result) {
  // Leave activities could notify group members
  // For now, no federation (could be enhanced)
  return { shouldFederate: false };
}

export default async function Leave(activity) {
  try {
    // 1. Validate
    const validation = validate(activity);
    if (!validation.valid) {
      return { activity, error: validation.errors.join("; ") };
    }

    // ---- Another server's group: decided by the id's domain, not by
    // whether a Group doc exists here (remote groups can be cached locally).
    // Groups are server-only for now (see the Join handler), so this is only
    // ever someone getting out of a membership made before that: drop it from
    // their Groups circle and tell the group's server, which still accepts
    // Leave (routes/inbox/post.js).
    const groupDomain = kowloonId(activity.target).domain;
    if (groupDomain && !isLocalDomain(groupDomain)) {
      const u = await User.findOne({ id: activity.actorId }).select("circles").lean();
      if (u?.circles?.groups) {
        await Circle.updateOne(
          { id: u.circles.groups, "members.id": activity.target },
          { $pull: { members: { id: activity.target } }, $inc: { memberCount: -1 } }
        );
      }
      return {
        activity,
        created: { federate: true },
        result: { left: true, remote: true },
        federate: true,
        federation: { shouldFederate: true, scope: "domain", domains: [groupDomain] },
      };
    }

    const groupDoc = await Group.findOne({ id: activity.target });
    if (!groupDoc) return { activity, error: "Leave: Group not found" };

    // ---- Deleted guard ----
    if (groupDoc?.deletedAt) {
      return { activity, error: "Leave: group is deleted" };
    }

    // ---- Helpers ----
    const pull = async (circleId, userId) =>
      circleId
        ? Circle.updateOne(
            { id: circleId, "members.id": userId },
            {
              $pull: { members: { id: userId } },
              $inc: { memberCount: -1 },
              $set: { updatedAt: new Date() },
            }
          )
        : { modifiedCount: 0 };

    const removedFrom = [];

    // ========================================================================
    // GROUP LEAVE
    // ========================================================================
    const { circles } = groupDoc;
    if (!circles?.members) {
      return { activity, error: "Leave: group circles not initialized" };
    }

    const ops = await Promise.all([
      pull(circles.members, activity.actorId),
      pull(circles.pending, activity.actorId),
    ]);

    if ((ops[0].modifiedCount || 0) > 0) removedFrom.push("members");
    if ((ops[1].modifiedCount || 0) > 0) removedFrom.push("pending");

    // Decrement Group.memberCount if they were actually removed from members
    if (ops[0].modifiedCount > 0) {
      await Group.updateOne({ id: groupDoc.id }, { $inc: { memberCount: -1 } });
    }

    // Remove group from user's Groups circle
    if (removedFrom.length > 0) {
      const u = await User.findOne({ id: activity.actorId }).select("circles").lean();
      if (u?.circles?.groups) {
        await Circle.updateOne(
          { id: u.circles.groups, "members.id": activity.target },
          {
            $pull: { members: { id: activity.target } },
            $inc: { memberCount: -1 },
          }
        );
      }
    }

    activity.objectId = activity.actorId;

    const result = {
      group: groupDoc,
      left: removedFrom.length > 0,
      removedFrom,
    };

    // 3. Determine federation requirements
    const federation = await getFederationTargets(activity, result);

    return {
      activity,
      created: result,
      result,
      federation,
    };
  } catch (err) {
    return { activity, error: err?.message || String(err) };
  }
}
