// routes/admin/flagged.js
import express from "express";
import route from "../utils/route.js";
import makeCollection from "../utils/makeCollection.js";
import { Flag, Post, Reply, Page, Bookmark, Group, Circle, User, FeedItems } from "#schema";
import createNotification from "#methods/notifications/create.js";
import { getSetting } from "#methods/settings/cache.js";

const router = express.Router({ mergeParams: true });

const MODELS = { Post, Reply, Page, Bookmark, Group, Circle };
// Notification.objectType has a narrower enum than the set of flaggable
// types (no "Circle") -- only pass objectType through when it's safe, so
// createNotification doesn't throw a schema validation error.
const NOTIF_OBJECT_TYPES = new Set(["Post", "Reply", "Page", "Bookmark", "Group"]);

function sanitize(doc) {
  const { _id, __v, ...rest } = doc;
  return rest;
}

function hrefForTarget(targetType, targetId) {
  const domain = getSetting("domain");
  const base = `https://${domain}`;
  if (!targetId) return base;
  switch (targetType) {
    case "Post":
    case "Reply":
      return `${base}/posts/${encodeURIComponent(targetId)}`;
    case "Group":
      return `${base}/groups/${encodeURIComponent(targetId)}`;
    case "Circle":
      return `${base}/circles/${encodeURIComponent(targetId)}`;
    case "Page":
      return `${base}/pages/${encodeURIComponent(targetId)}`;
    case "Bookmark":
      return `${base}/bookmarks/${encodeURIComponent(targetId)}`;
    default:
      return base;
  }
}

function notifyObjectFields(flag) {
  return NOTIF_OBJECT_TYPES.has(flag.targetType)
    ? { objectId: flag.target, objectType: flag.targetType }
    : { objectId: flag.target };
}

router.get(
  "/",
  makeCollection({
    model: Flag,
    buildQuery: (req, { query }) => {
      const filter = {};
      filter.status = query.status || "open";
      if (query.targetType) filter.targetType = query.targetType;
      if (query.actorId) filter.actorId = query.actorId;
      return filter;
    },
    sort: { createdAt: -1 },
    sanitize,
    routeOpts: { allowUnauth: false },
  })
);

// GET /admin/flagged/:id
router.get(
  "/:id",
  route(
    async ({ params, set, setStatus }) => {
      const flag = await Flag.findOne({ id: decodeURIComponent(params.id) }).lean();
      if (!flag) {
        setStatus(404);
        set("error", "Flag not found");
        return;
      }
      set("flag", sanitize(flag));
    },
    { allowUnauth: false }
  )
);

// PATCH /admin/flagged/:id — edit notes/status directly, no target action or
// notifications. Kept for simple bookkeeping; the moderation page's action
// buttons use the dedicated endpoints below instead.
router.patch(
  "/:id",
  route(
    async ({ params, body, user: adminUser, set, setStatus }) => {
      const flag = await Flag.findOne({ id: decodeURIComponent(params.id) });
      if (!flag) {
        setStatus(404);
        set("error", "Flag not found");
        return;
      }

      const { status, notes } = body;
      if (status && !["resolved", "dismissed"].includes(status)) {
        setStatus(400);
        set("error", "status must be 'resolved' or 'dismissed'");
        return;
      }

      if (status) {
        flag.status = status;
        flag.resolvedAt = new Date();
        flag.resolvedBy = adminUser.id;
      }
      if (notes !== undefined) flag.notes = notes;
      await flag.save();

      set("ok", true);
      set("flag", sanitize(flag.toObject()));
    },
    { allowUnauth: false }
  )
);

// Shared prelude: load the flag, 404 if missing, 409 if already handled --
// these action endpoints are one-shot, not idempotent re-triggers.
async function loadOpenFlag(id, setStatus, set) {
  const flag = await Flag.findOne({ id: decodeURIComponent(id) });
  if (!flag) {
    setStatus(404);
    set("error", "Flag not found");
    return null;
  }
  if (flag.status !== "open") {
    setStatus(409);
    set("error", `Flag already ${flag.status}`);
    return null;
  }
  return flag;
}

// POST /admin/flagged/:id/ignore — dismiss with no action on the target.
// Notifies the reporter only.
router.post(
  "/:id/ignore",
  route(
    async ({ params, user: adminUser, set, setStatus }) => {
      const flag = await loadOpenFlag(params.id, setStatus, set);
      if (!flag) return;

      flag.status = "dismissed";
      flag.resolvedAt = new Date();
      flag.resolvedBy = adminUser.id;
      await flag.save();

      await createNotification({
        type: "moderation",
        recipientId: flag.actorId,
        actorId: adminUser.id,
        ...notifyObjectFields(flag),
        summary: "Thanks for the report — after review, no action was taken.",
        href: hrefForTarget(flag.targetType, flag.target),
      });

      set("ok", true);
      set("flag", sanitize(flag.toObject()));
    },
    { allowUnauth: false }
  )
);

// POST /admin/flagged/:id/remove — soft-delete the target, resolve the flag.
// Notifies the reporter and the target's author.
router.post(
  "/:id/remove",
  route(
    async ({ params, user: adminUser, set, setStatus }) => {
      const flag = await loadOpenFlag(params.id, setStatus, set);
      if (!flag) return;

      if (flag.targetType === "User") {
        setStatus(400);
        set("error", "Use \"Block\" to act on a User target, not Remove");
        return;
      }

      const model = MODELS[flag.targetType];
      const target = model ? await model.findOne({ id: flag.target }) : null;
      if (target && !target.deletedAt) {
        target.deletedAt = new Date();
        target.deletedBy = adminUser.id;
        await target.save();
        if (flag.targetType === "Reply" && target.target) {
          await Post.updateOne({ id: target.target }, { $inc: { replyCount: -1 } }).catch(() => {});
        }
      }

      flag.status = "resolved";
      flag.resolvedAt = new Date();
      flag.resolvedBy = adminUser.id;
      await flag.save();

      const reasonSuffix = flag.reason?.label ? ` (reason: ${flag.reason.label})` : "";

      await createNotification({
        type: "moderation",
        recipientId: flag.actorId,
        actorId: adminUser.id,
        ...notifyObjectFields(flag),
        summary: "Thanks for the report — the item you flagged was removed.",
        href: hrefForTarget(flag.targetType, flag.target),
      });

      if (flag.targetActorId) {
        await createNotification({
          type: "moderation",
          recipientId: flag.targetActorId,
          actorId: adminUser.id,
          ...notifyObjectFields(flag),
          summary: `Your ${(flag.targetType || "item").toLowerCase()} was removed by a moderator${reasonSuffix}.`,
          href: hrefForTarget(flag.targetType, flag.target),
        });
      }

      set("ok", true);
      set("flag", sanitize(flag.toObject()));
      set("targetFound", !!target);
    },
    { allowUnauth: false }
  )
);

// POST /admin/flagged/:id/hard-delete — permanently delete the target,
// resolve the flag. Notifies the reporter and the target's author. For
// content serious enough that even the soft-deleted record shouldn't linger.
router.post(
  "/:id/hard-delete",
  route(
    async ({ params, user: adminUser, set, setStatus }) => {
      const flag = await loadOpenFlag(params.id, setStatus, set);
      if (!flag) return;

      if (flag.targetType === "User") {
        setStatus(400);
        set("error", "Use \"Block\" to act on a User target, not Hard Delete");
        return;
      }

      const model = MODELS[flag.targetType];
      let targetFound = false;
      if (model) {
        const targetDoc = await model.findOne({ id: flag.target }).select("target");
        if (targetDoc) {
          targetFound = true;
          if (flag.targetType === "Post") {
            await FeedItems.deleteMany({ id: flag.target }).catch(() => {});
          }
          if (flag.targetType === "Reply" && targetDoc.target) {
            await Post.updateOne({ id: targetDoc.target }, { $inc: { replyCount: -1 } }).catch(() => {});
          }
          await model.deleteOne({ id: flag.target });
        }
      }

      flag.status = "resolved";
      flag.resolvedAt = new Date();
      flag.resolvedBy = adminUser.id;
      await flag.save();

      const reasonSuffix = flag.reason?.label ? ` (reason: ${flag.reason.label})` : "";

      await createNotification({
        type: "moderation",
        recipientId: flag.actorId,
        actorId: adminUser.id,
        ...notifyObjectFields(flag),
        summary: "Thanks for the report — the item you flagged was removed.",
        href: hrefForTarget(flag.targetType, flag.target),
      });

      if (flag.targetActorId) {
        await createNotification({
          type: "moderation",
          recipientId: flag.targetActorId,
          actorId: adminUser.id,
          ...notifyObjectFields(flag),
          summary: `Your ${(flag.targetType || "item").toLowerCase()} was removed by a moderator${reasonSuffix}.`,
          href: hrefForTarget(flag.targetType, flag.target),
        });
      }

      set("ok", true);
      set("flag", sanitize(flag.toObject()));
      set("targetFound", targetFound);
    },
    { allowUnauth: false }
  )
);

// POST /admin/flagged/:id/block — deactivate the target's author account,
// resolve the flag. Notifies the reporter only -- a deactivated account
// can't read notifications, and there's no separate ask to tell the blocked
// user why.
router.post(
  "/:id/block",
  route(
    async ({ params, user: adminUser, set, setStatus }) => {
      const flag = await loadOpenFlag(params.id, setStatus, set);
      if (!flag) return;

      if (!flag.targetActorId) {
        setStatus(400);
        set("error", "This flag has no known author to block");
        return;
      }

      const author = await User.findOne({ id: flag.targetActorId });
      if (!author) {
        setStatus(404);
        set("error", "Author account not found");
        return;
      }
      author.active = false;
      author.deletedAt = new Date();
      await author.save();

      flag.status = "resolved";
      flag.resolvedAt = new Date();
      flag.resolvedBy = adminUser.id;
      await flag.save();

      await createNotification({
        type: "moderation",
        recipientId: flag.actorId,
        actorId: adminUser.id,
        ...notifyObjectFields(flag),
        summary: "Thanks for the report — the user was blocked.",
        href: hrefForTarget(flag.targetType, flag.target),
      });

      set("ok", true);
      set("flag", sanitize(flag.toObject()));
    },
    { allowUnauth: false }
  )
);

export default router;
