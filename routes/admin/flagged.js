// routes/admin/flagged.js
import express from "express";
import route from "../utils/route.js";
import makeCollection from "../utils/makeCollection.js";
import { Flag, Post, Reply, Page, Bookmark, Group, Circle, User, FeedItems } from "#schema";
import createNotification from "#methods/notifications/create.js";
import { getSetting } from "#methods/settings/cache.js";
import { addToList, BlocklistError } from "#methods/moderation/blocklist.js";

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

// Flags store bare IDs. Admin screens need something a person recognises --
// the reported thing's title (or an excerpt), and the author's and
// reporter's display names -- so list/detail responses carry those too.
function plainExcerpt(html, max = 120) {
  const text = String(html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}...` : text;
}

async function actorSummary(id) {
  if (!id) return null;
  const u = await User.findOne({ id }).select("id username profile.name profile.icon").lean();
  if (!u) return { id, name: null, icon: null };
  return { id: u.id, name: u.profile?.name || u.username || null, icon: u.profile?.icon || null };
}

async function targetSummary(flag, { full = false } = {}) {
  if (flag.targetType === "User") {
    const u = await User.findOne({ id: flag.target })
      .select("id username profile.name profile.description deletedAt active")
      .lean();
    if (!u) return { exists: false };
    return {
      exists: true,
      removed: !!u.deletedAt || u.active === false,
      title: u.profile?.name || u.username || null,
      excerpt: plainExcerpt(u.profile?.description, full ? 600 : 120) || null,
    };
  }
  const Model = MODELS[flag.targetType];
  if (!Model) return { exists: false };
  const doc = await Model.findOne({ id: flag.target })
    .select("name title summary body source deletedAt type image attachments actorId")
    .lean();
  if (!doc) return { exists: false };
  const bodyHtml = doc.body ?? doc.source?.content ?? "";
  const title = doc.name || doc.title || null;
  const excerpt = plainExcerpt(doc.summary || bodyHtml, full ? 600 : 120) || null;
  const out = {
    exists: true,
    removed: !!doc.deletedAt,
    type: doc.type || flag.targetType,
    title,
    excerpt,
    actorId: doc.actorId || null,
  };
  if (full) {
    out.image = doc.image || null;
    out.attachments = (doc.attachments || []).slice(0, 4).map((a) => ({
      url: a.url,
      mediaType: a.mediaType,
      name: a.name,
    }));
  }
  return out;
}

async function enrichFlag(flag, opts) {
  const [reporter, resolver, target] = await Promise.all([
    actorSummary(flag.actorId),
    opts?.full ? actorSummary(flag.resolvedBy) : null,
    targetSummary(flag, opts),
  ]);
  // Older flags (and some clients) never recorded the author; the reported
  // object itself knows who wrote it.
  const authorId = flag.targetActorId || target?.actorId || null;
  const targetActor = await actorSummary(authorId);
  return {
    ...sanitize(flag),
    targetActorId: authorId,
    targetActor,
    reporter,
    ...(opts?.full ? { resolver } : {}),
    targetSummary: target,
  };
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
    sanitize: (doc) => enrichFlag(doc),
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
      set("flag", await enrichFlag(flag, { full: true }));
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

// POST /admin/flagged/:id/block { confirmBan?, summary? } -- put the
// target's author on the server's Blocked list and resolve the flag. For a
// local author that's a ban (permanent deletion; needs confirmBan: true,
// else 409). Notifies the reporter only.
router.post(
  "/:id/block",
  route(
    async ({ params, body, user: adminUser, set, setStatus }) => {
      const flag = await loadOpenFlag(params.id, setStatus, set);
      if (!flag) return;

      if (!flag.targetActorId) {
        // Older flags didn't record the author; ask the reported object.
        const Model = MODELS[flag.targetType];
        const doc = Model
          ? await Model.findOne({ id: flag.target }).select("actorId").lean()
          : null;
        if (doc?.actorId) flag.targetActorId = doc.actorId;
      }
      if (!flag.targetActorId) {
        setStatus(400);
        set("error", "This flag has no known author to block");
        return;
      }

      // Goes on the server's Blocked list (methods/moderation/blocklist.js).
      // For someone on THIS server that's a ban: their account and content
      // are permanently deleted, so the admin must confirm it (confirmBan).
      // For someone elsewhere, everything they send us is refused.
      try {
        await addToList({
          list: "blocked",
          target: flag.targetActorId,
          summary: typeof body?.summary === "string" && body.summary.trim()
            ? body.summary
            : `Reported for ${flag.reason?.label || flag.reason?.code || "a rules violation"}`,
          confirmBan: body?.confirmBan === true,
        });
      } catch (err) {
        if (err instanceof BlocklistError) {
          setStatus(err.status);
          set("error", err.message);
          return;
        }
        throw err;
      }

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
