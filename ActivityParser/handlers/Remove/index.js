// /ActivityParser/handlers/Remove/index.js
import { Group, Circle } from "#schema";
import getSettings from "#methods/settings/get.js";
import isServerAdmin from "#methods/auth/isServerAdmin.js";
import { isServerModerator } from "#methods/auth/staffPolicy.js";
import isGroupAdmin from "#methods/groups/isAdmin.js";
import regenerateCircleIcon from "#methods/circles/regenerateCircleIcon.js";

export default async function Remove(activity) {
  try {
    const settings = await getSettings();

    // Support two patterns:
    // 1. Legacy: target = circle ID (explicit circle)
    // 2. New: to = group ID, target = optional circle ID (defaults to members)
    let targetCircle;
    let ownerId;
    let ownerType;

    if (activity.to && /^group:[^@]+@[^@]+$/.test(activity.to)) {
      // New pattern: to = groupId, target = optional specific circle
      const group = await Group.findOne({ id: activity.to }).select("circles").lean();
      if (!group) return { activity, error: "Group not found" };

      ownerId = activity.to;
      ownerType = "Group";

      // If target is specified, verify it belongs to this group
      if (activity.target) {
        if (!activity.target.startsWith("circle:"))
          return { activity, error: "Invalid target Circle" };

        // Verify the target circle belongs to this group
        const circleIds = Object.values(group.circles || {});
        if (!circleIds.includes(activity.target)) {
          return { activity, error: "Target circle does not belong to this group" };
        }

        targetCircle = await Circle.findOne({ id: activity.target });
        if (!targetCircle) return { activity, error: "Target circle not found" };
      } else {
        // Default to members circle
        if (!group.circles?.members) {
          return { activity, error: "Group members circle not found" };
        }
        targetCircle = await Circle.findOne({ id: group.circles.members });
        if (!targetCircle) return { activity, error: "Group members circle not found" };
        activity.target = group.circles.members; // Set for downstream code
      }
    } else {
      // Legacy pattern: target = circle ID
      if (!activity?.target) {
        return { activity, error: "No target Circle specified" };
      }
      if (!activity.target.startsWith("circle:")) {
        return { activity, error: "Invalid target Circle" };
      }

      targetCircle = await Circle.findOne({ id: activity.target });
      if (!targetCircle) {
        return { activity, error: "Target circle not found" };
      }

      ownerId = targetCircle?.actorId || "";
      ownerType = /^group:[^@]+@[^@]+$/.test(ownerId)
        ? "Group"
        : /^@[^@]+@[^@]+$/.test(ownerId)
        ? "User"
        : /^@[^@]+$/.test(ownerId)
        ? "Server"
        : "Unknown";
    }

    // ---- Permissions ----
    switch (ownerType) {
      case "User": {
        if (activity.actorId !== targetCircle.actorId) {
          return { activity, error: "You are not the owner of this circle" };
        }
        break;
      }
      case "Server": {
        // Must be local server's circle
        if (targetCircle.actorId !== settings.actorId) {
          return { activity, error: "Cannot update remote server Circles" };
        }
        // Server-owned circles are admin-only; the block lists go through
        // Moderation (see the Add handler).
        if (
          !(await isServerAdmin(activity.actorId)) &&
          !(targetCircle.type !== "System" && (await isServerModerator(activity.actorId)))
        ) {
          return { activity, error: "You are not a server admin" };
        }
        if ([settings.blockedCircle, settings.defederatedCircle].includes(activity.target)) {
          return { activity, error: "Use Moderation to change the server's block lists" };
        }
        break;
      }
      case "Group": {
        if (!(await isGroupAdmin(activity.actorId, targetCircle.actorId))) {
          return { activity, error: "You are not a group admin" };
        }
        break;
      }
      default: {
        return { activity, error: "Unsupported circle owner type" };
      }
    }

    // ---- Resolve the subject to remove — only the id field matters for $pull ----
    function resolveMemberId(ref) {
      if (typeof ref === "string") {
        const s = ref.trim();
        // @user@domain or bare @domain server entry
        if (/^@/.test(s)) return s;
        return s;
      }
      if (ref && typeof ref === "object") {
        // Accept { id }, { actorId }, or a full member/user object
        return ref.id || ref.actorId || "";
      }
      return "";
    }

    const memberId = resolveMemberId(activity.object);
    if (!memberId) {
      return { activity, error: "Remove: could not resolve member to remove" };
    }
    const member = { id: memberId };

    activity.object = member;

    // ---- Atomic remove (only if present), decrement counter ----
    const res = await Circle.updateOne(
      { id: activity.target, "members.id": activity.object.id },
      {
        $pull: { members: { id: activity.object.id } },
        $inc: { memberCount: -1 },
      }
    );

    let removed = (res.modifiedCount || 0) > 0;

    // Kick from a Group's members circle: decrement Group.memberCount the
    // same guarded way Leave does (only if the $pull actually removed them).
    if (ownerType === "Group" && removed) {
      const g = await Group.findOne({ id: ownerId }).select("circles").lean();
      if (g?.circles?.members === activity.target) {
        await Group.updateOne(
          { id: ownerId, memberCount: { $gt: 0 } },
          { $inc: { memberCount: -1 } }
        );
      }
    }

    // If removing from a Group and not found in target circle, try pending circle
    if (ownerType === "Group" && !removed) {
      const group = await Group.findOne({ id: ownerId }).select("circles").lean();
      if (group?.circles?.pending) {
        const pendingRes = await Circle.updateOne(
          { id: group.circles.pending, "members.id": activity.object.id },
          {
            $pull: { members: { id: activity.object.id } },
            $inc: { memberCount: -1 },
          }
        );
        removed = (pendingRes.modifiedCount || 0) > 0;
      }
    }

    // Refresh the auto-generated mosaic icon for user Circles (not Group circles)
    // when a member was actually removed. Fire-and-forget; self-guards.
    if (ownerType === "User" && removed) {
      regenerateCircleIcon(activity.target).catch(() => {});
    }

    return {
      activity,
      circleId: activity.target,
      removed,
      federate: false,
    };
  } catch (err) {
    return { activity, error: err?.message || String(err) };
  }
}
