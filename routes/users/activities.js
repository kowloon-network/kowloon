// routes/users/activities.js
// GET /users/:id/activities — User's activity log

import makeCollection from "../utils/makeCollection.js";
import { Activity } from "#schema";
import isServerAdmin from "#methods/auth/isServerAdmin.js";

export default makeCollection({
  model: Activity,
  buildQuery: async (req, { user }) => {
    const actorId = String(decodeURIComponent(req.params.id));
    const filter = { actorId, deletedAt: null };

    // SECURITY: this returned a user's ENTIRE activity log to anyone,
    // unauthenticated -- every Block/Mute/Add-to-circle, every Flag (report)
    // they filed, and the ids/audiences of their private posts. The owner (or
    // a server admin) still gets everything; everyone else only sees public
    // Create activities, and never a Flag.
    const viewerId = user?.id || null;
    const privileged = viewerId && (viewerId === actorId || (await isServerAdmin(viewerId)));
    if (!privileged) {
      filter.type = "Create";
      filter.to = "@public";
      filter.objectType = { $nin: ["Flag", "User", "Bookmark"] };
    }
    return filter;
  },
  select: "id type actorId objectType objectId to createdAt",
  sort: { createdAt: -1 },
});
