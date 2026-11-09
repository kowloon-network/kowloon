// routes/circles/id.js
// GET /circles/:id — Circle details (authorized users)
//
// "Authorized" means:
//   - @public circles: anyone
//   - @server circles: any authenticated user on this server
//   - circle-addressed: owner + members of that circle
//   - private / empty: owner only

import route from "../utils/route.js";
import { Circle } from "#schema";
import { getServerSettings } from "#methods/settings/schemaHelpers.js";
import { getSetting } from "#methods/settings/cache.js";
import isServerAdmin from "#methods/auth/isServerAdmin.js";

export default route(async ({ req, params, user, set, setStatus }) => {
  const id = decodeURIComponent(params.id);
  const circle = await Circle.findOne({ id, deletedAt: null }).lean();

  if (!circle) {
    setStatus(404);
    set("error", "Circle not found");
    return;
  }

  const { domain } = getServerSettings();
  const to = circle.to || "";
  const isPublic = to === "@public" || to === "public";
  const isServerVisible =
    to === `@${domain}` || to === "@server" || to === "server";
  const isOwner = user?.id && circle.actorId === user?.id;
  const isMember =
    user?.id && circle.members?.some((m) => m.id === user?.id);

  // Hardening (#31): the server's admin/mod rosters are internal. They are
  // server-tier (to: @<domain>), so the isServerVisible gate below would leak
  // their metadata (and members) to any local user who has the id. Gate them to
  // owner/server-admin only, and 404 (not 403) so their existence isn't
  // confirmed. Identify precisely via settings — NOT actorId === @<domain>,
  // which would also hide legit curated-people circles.
  const adminCircle = getSetting("adminCircle");
  const modCircle = getSetting("modCircle");
  if (id === adminCircle || id === modCircle) {
    const admin = user?.id ? await isServerAdmin(user.id) : false;
    if (!isOwner && !admin) {
      setStatus(404);
      set("error", "Circle not found");
      return;
    }
  }

  // SECURITY: System circles (a user's Following / All Following / Groups /
  // Blocked / Muted, and a Group's Admins / Moderators / Members / Blocked /
  // Pending -- owned by the group id) are internal bookkeeping. The isMember
  // exception below let anyone IN one read all of it -- e.g. everyone you
  // follow could list your whole Following circle, and blocked users could
  // read your Blocked list. Owner or server admin only; 404 so existence
  // isn't confirmed. (Group member lists are served by GET
  // /groups/:id/members under the group's own visibility.)
  const viewerIsAdmin = user?.id ? await isServerAdmin(user.id) : false;
  if (circle.type === "System" && !isOwner && !viewerIsAdmin) {
    setStatus(404);
    set("error", "Circle not found");
    return;
  }

  if (!isPublic) {
    if (!user?.id) {
      setStatus(401);
      set("error", "Authentication required");
      return;
    }
    if (!isOwner && !isMember && !isServerVisible) {
      setStatus(403);
      set("error", "Access denied");
      return;
    }
  }

  // Expose isOwner and isMember to the client so the UI can gate actions
  const result = { ...circle, isOwner: !!isOwner, isMember: !!isMember };
  // SECURITY: being a member of a private circle lets you see the circle,
  // not who else is in it. The member list is only exposed to the owner /
  // server admin, or when the circle itself is @public or addressed to this
  // server (and the viewer is a local user, enforced above).
  if (!isOwner && !viewerIsAdmin && !isPublic && !isServerVisible) {
    delete result.members;
  }
  set("item", result);
});
