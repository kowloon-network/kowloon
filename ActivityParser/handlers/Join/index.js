// #ActivityParser/handlers/Join/index.js
import { Group, Circle, User } from "#schema";
import getFederationTargetsHelper from "../utils/getFederationTargets.js";
import createNotification from "#methods/notifications/create.js";
import kowloonId from "#methods/parse/kowloonId.js";
import isLocalDomain from "#methods/parse/isLocalDomain.js";

/**
 * Type-specific validation for Join activities
 * Per specification: target (Group ID) is REQUIRED
 * @param {Object} activity
 * @returns {{ valid: boolean, errors?: string[] }}
 */
export function validate(activity) {
  const errors = [];

  if (!activity?.actorId || typeof activity.actorId !== "string") {
    errors.push("Join: missing activity.actorId");
  }

  // Required: target (Group ID)
  if (!activity?.target || typeof activity.target !== "string") {
    errors.push("Join: missing required field 'target' (Group ID)");
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Determine federation targets for Join activity
 * @param {Object} activity - The activity envelope
 * @param {Object} result - The join result
 * @returns {Promise<FederationRequirements>}
 */
export async function getFederationTargets(activity, result) {
  // Join activities could notify group members
  // For now, no federation (could be enhanced)
  return { shouldFederate: false };
}

export default async function Join(activity, ctx = {}) {
  try {
    // 1. Validate
    const validation = validate(activity);
    if (!validation.valid) {
      return { activity, error: validation.errors.join("; ") };
    }

    const actorId = activity.actorId;
    const targetId = activity.target;

    // GROUPS ARE SERVER-ONLY FOR NOW (beta, 2026-11-24). Cross-server
    // membership is broken (remote groups get hydrated locally, group posts
    // never reach remote members, approvals fail...), so only this server's
    // own members can join this server's own groups. Decided by the ids'
    // domains, NOT by whether a Group doc exists here -- remote groups can
    // be cached locally. Undo this (and the matching check in
    // routes/inbox/post.js) once cross-server groups are rebuilt.
    const groupDomain = kowloonId(targetId).domain;
    if (!groupDomain || !isLocalDomain(groupDomain)) {
      return { activity, error: "Join: groups on other servers can't be joined yet" };
    }
    const actorDomain = kowloonId(actorId).domain;
    if (!actorDomain || !isLocalDomain(actorDomain)) {
      return { activity, error: "Join: only members of this server can join its groups" };
    }

    // Resolve target: Group only (Events are now Posts)
    const target = await Group.findOne({ id: targetId }).lean();
    if (!target) return { activity, error: "Join: Group not found" };

    // Blocked check
    if (target.circles?.blocked) {
      const isBlocked = await Circle.exists({
        id: target.circles.blocked,
        "members.id": actorId,
      });
      if (isBlocked)
        return {
          activity,
          error: "Join: user is blocked from this group",
        };
    }

    // Policy check
    // - open: anyone can join without approval
    // - serverOpen: local server members join freely, remote users need approval
    // - serverApproval: only local server members can join, with approval
    // - approvalOnly: everyone needs approval
    const policy = target.rsvpPolicy || "open";
    const parsed = kowloonId(actorId);
    const actorIsLocal = parsed.domain && isLocalDomain(parsed.domain);

    // inviteOnly: nobody self-joins. Admins add members explicitly via an
    // Add activity, so a Join request is never valid here.
    if (policy === "inviteOnly") {
      return { activity, error: "Join: this group is invite-only" };
    }

    // Determine if this actor needs approval or is denied
    let needsApproval = false;
    if (policy === "approvalOnly") {
      needsApproval = true;
    } else if (policy === "serverOpen") {
      needsApproval = !actorIsLocal; // remote users need approval
    } else if (policy === "serverApproval") {
      if (!actorIsLocal) {
        return { activity, error: "Join: only server members can join this group" };
      }
      needsApproval = true;
    }
    // policy === "open" → needsApproval stays false

    if (needsApproval) {
      // Add to pending circle for admin approval
      const pendingCircle = target.circles?.pending;
      if (!pendingCircle) {
        return {
          activity,
          error: "Join: approval pending queue not configured for this group",
        };
      }

      // Build member object (light enrichment if local user exists)
      const u = await User.findOne({ id: actorId }).lean();
      const member = u
        ? {
            id: u.id,
            name: u?.profile?.name,
            icon: u?.profile?.icon,
            url: u?.url,
            inbox: u?.inbox,
            outbox: u?.outbox,
            server: u?.server,
          }
        : { id: actorId };

      const updateRes = await Circle.updateOne(
        { id: pendingCircle, "members.id": { $ne: actorId } },
        { $push: { members: member }, $inc: { memberCount: 1 } }
      );

      // Notify group admins about the join request (only if actually added to pending)
      if (updateRes.modifiedCount > 0 && target.circles?.admins) {
        try {
          const adminCircle = await Circle.findOne({ id: target.circles.admins })
            .select("members")
            .lean();

          if (adminCircle?.members?.length > 0) {
            // Get admin IDs and fetch their prefs
            const adminIds = adminCircle.members.map((m) => m.id).filter(Boolean);
            const adminsWithPrefs = await User.find({ id: { $in: adminIds } })
              .select("id prefs")
              .lean();

            // Build map of who wants notifications
            const wantsNotification = new Map();
            for (const admin of adminsWithPrefs) {
              wantsNotification.set(
                admin.id,
                admin.prefs?.notifications?.join_request !== false
              );
            }

            // Create notification for admins who want them
            const notificationPromises = adminCircle.members
              .filter((admin) => wantsNotification.get(admin.id) !== false)
              .map((admin) =>
                createNotification({
                  type: "join_request",
                  recipientId: admin.id,
                  actorId,
                  objectId: targetId,
                  objectType: "Group",
                  activityId: activity.id,
                  activityType: "Join",
                  groupKey: `join_request:${targetId}:${actorId}`,
                })
              );

            if (notificationPromises.length > 0) {
              await Promise.all(notificationPromises);
            }
          }
        } catch (err) {
          console.error("Failed to create join_request notifications:", err.message);
          // Non-fatal
        }
      }

      const result = { type: "Group", status: "pending" };
      const federation = await getFederationTargets(activity, result);

      return {
        activity,
        created: result,
        result,
        federation,
      };
    }
    // Proceed for open join (no approval needed)

    // Build member object (light enrichment if local user exists)
    const u = await User.findOne({ id: actorId }).lean();
    const member = u
      ? {
          id: u.id,
          name: u?.profile?.name,
          icon: u?.profile?.icon,
          url: u?.url,
          inbox: u?.inbox,
          outbox: u?.outbox,
          server: u?.server,
        }
      : { id: actorId };

    const destCircle = target.circles?.members;
    if (!destCircle) {
      return {
        activity,
        error: "Join: group has no members circle",
      };
    }

    const res = await Circle.updateOne(
      { id: destCircle, "members.id": { $ne: member.id } },
      { $push: { members: member }, $inc: { memberCount: 1 } }
    );

    if (res.modifiedCount > 0) {
      await Group.updateOne({ id: target.id }, { $inc: { memberCount: 1 } });

      // Add group to user's Groups circle
      if (u?.circles?.groups) {
        const groupMember = {
          id: target.id,
          name: target.name || "",
          icon: target.icon || "",
          url: target.url || "",
          inbox: target.inbox || "",
          outbox: target.outbox || "",
          server: target.server || "",
        };
        await Circle.updateOne(
          { id: u.circles.groups, "members.id": { $ne: target.id } },
          { $push: { members: groupMember }, $inc: { memberCount: 1 } }
        );
      }

      const result = { type: "Group", status: "joined" };
      const federation = await getFederationTargets(activity, result);

      return {
        activity,
        created: result,
        result,
        federation,
      };
    } else {
      const result = { type: "Group", status: "already_joined" };
      const federation = await getFederationTargets(activity, result);

      return {
        activity,
        created: result,
        result,
        federation,
      };
    }
  } catch (err) {
    return { activity, error: err?.message || String(err) };
  }
}
