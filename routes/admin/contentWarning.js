// routes/admin/contentWarning.js
// POST /admin/content-warning { target, contentWarning, sensitive }
// A moderator or admin adds, changes or removes the warning on any post or
// reply they come across, without a report. Send contentWarning: null and
// sensitive: false to remove it. Notifies the author.

import express from "express";
import route from "../utils/route.js";
import { Post, Reply, FeedItems } from "#schema";
import { isStaff } from "#methods/auth/staffPolicy.js";
import { getSetting } from "#methods/settings/cache.js";
import { applyModeratorWarning, notifyAuthorOfWarning } from "#methods/moderation/contentWarning.js";

const router = express.Router({ mergeParams: true });

router.post(
  "/",
  route(
    async ({ req, body, user, set, setStatus }) => {
      const target = typeof body?.target === "string" ? body.target.trim() : "";
      if (!/^(post|reply):/i.test(target)) {
        setStatus(400);
        set("error", "target must be a post or reply id");
        return;
      }

      // Moderators can't act on an admin's or moderator's content.
      if (req.staffRole === "mod") {
        const Model = /^reply:/i.test(target) ? Reply : Post;
        const doc =
          (await Model.findOne({ id: target }).select("actorId").lean()) ||
          (await FeedItems.findOne({ id: target }).select("actorId").lean());
        if (doc?.actorId && (await isStaff(doc.actorId))) {
          setStatus(403);
          set("error", "Only an admin can act on an admin's or moderator's content");
          return;
        }
      }

      const result = await applyModeratorWarning({
        targetId: target,
        contentWarning: body.contentWarning,
        sensitive: body.sensitive,
        staffId: user.id,
      });
      if (!result.found) {
        setStatus(404);
        set("error", "Post not found");
        return;
      }

      const href = `https://${getSetting("domain")}/posts/${encodeURIComponent(target)}`;
      await notifyAuthorOfWarning({ result, staffId: user.id, targetId: target, href });

      set("ok", true);
      set("contentWarning", result.contentWarning);
      set("sensitive", result.sensitive);
    },
    { allowUnauth: false }
  )
);

export default router;
