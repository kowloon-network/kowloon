// routes/admin/posts.js
import express from "express";
import route from "../utils/route.js";
import makeCollection from "../utils/makeCollection.js";
import { Post, FeedItems } from "#schema";
import writeFeedItems from "#methods/feed/writeFeedItems.js";
import { getSetting } from "#methods/settings/cache.js";
import { getServerActor } from "#methods/settings/schemaHelpers.js";
import resolveAttachments from "#methods/files/resolveAttachment.js";

const router = express.Router({ mergeParams: true });

const ALLOWED_FIELDS = [
  "type", "title", "source", "summary", "image",
  "attachments", "tags", "to", "canReply", "canReact", "location",
];

function sanitize(doc) {
  const { _id, __v, signature, ...rest } = doc;
  return rest;
}

function pick(obj, fields) {
  const result = {};
  for (const f of fields) {
    if (f in obj) result[f] = obj[f];
  }
  return result;
}

function getServerActorId() {
  const domain = getSetting("domain");
  return getSetting("actorId") || `@${domain}`;
}

router.get(
  "/",
  makeCollection({
    model: Post,
    buildQuery: (req, { query }) => {
      const filter = {};
      // Admin sees all public/server posts by default; pass ?visibility=all for circle/private posts too.
      // "@server" was never a real Post.to value (canonical server-wide posts are "@<domain>" -- see
      // methods/parse/canonicalTo.js) -- this filter was silently excluding real server-wide posts too,
      // not just the private circle/user ones it was meant to hide.
      if (query.visibility !== "all") {
        const domain = getSetting("domain");
        filter.to = { $in: ["@public", `@${domain}`] };
      }
      if (query.type) filter.type = query.type;
      if (query.actorId) filter.actorId = query.actorId;
      if (query.deleted === "true") {
        filter.deletedAt = { $ne: null };
      } else if (query.deleted !== "include") {
        filter.deletedAt = null;
      }
      return filter;
    },
    select: "-signature",
    sort: { createdAt: -1 },
    sanitize,
    routeOpts: { allowUnauth: false },
  })
);

// GET /admin/posts/:id
router.get(
  "/:id",
  route(
    async ({ params, set, setStatus }) => {
      const post = await Post.findOne({
        id: decodeURIComponent(params.id),
      })
        .select("-signature")
        .lean();

      if (!post) {
        setStatus(404);
        set("error", "Post not found");
        return;
      }
      set("post", sanitize(post));
    },
    { allowUnauth: false }
  )
);

// POST /admin/posts — create a server-owned announcement post
router.post(
  "/",
  route(
    async ({ body, set, setStatus }) => {
      if (!body.source?.content?.trim() && !body.title?.trim()) {
        setStatus(400);
        set("error", "source.content or title is required");
        return;
      }

      const fields = pick(body, ALLOWED_FIELDS);
      if (!fields.type) fields.type = "Note";
      if (!fields.to) fields.to = "@public";
      if (fields.attachments) {
        fields.attachments = await resolveAttachments(fields.attachments);
      }

      const post = await Post.create({
        ...fields,
        actorId: getServerActorId(),
        actor: getServerActor(),
      });

      await writeFeedItems(post.toObject(), "Post");

      setStatus(201);
      set("post", sanitize(post.toObject()));
    },
    { allowUnauth: false }
  )
);

// PATCH /admin/posts/:id — update a server-owned post
router.patch(
  "/:id",
  route(
    async ({ params, body, set, setStatus }) => {
      const post = await Post.findOne({
        id: decodeURIComponent(params.id),
        deletedAt: null,
      }).select("-attachments");

      if (!post) {
        setStatus(404);
        set("error", "Post not found");
        return;
      }

      if (post.actorId !== getServerActorId()) {
        setStatus(403);
        set("error", "Only server-owned posts can be edited via this endpoint");
        return;
      }

      const fields = pick(body, ALLOWED_FIELDS);
      if (fields.attachments) {
        fields.attachments = await resolveAttachments(fields.attachments);
      }
      Object.assign(post, fields);
      await post.save();

      await writeFeedItems(post.toObject(), "Post");

      set("ok", true);
      set("post", sanitize(post.toObject()));
    },
    { allowUnauth: false }
  )
);

// DELETE /admin/posts/:id — soft-delete (default) or hard-delete (?fullDelete=true)
router.delete(
  "/:id",
  route(
    async ({ params, query, user: adminUser, set, setStatus }) => {
      const post = await Post.findOne({ id: decodeURIComponent(params.id) }).select("-attachments");

      if (!post) {
        setStatus(404);
        set("error", "Post not found");
        return;
      }

      if (query.fullDelete === "true") {
        await FeedItems.deleteMany({ id: post.id });
        await Post.deleteOne({ id: post.id });
        set("ok", true);
        set("hardDeleted", true);
        return;
      }

      if (post.deletedAt) {
        setStatus(409);
        set("error", "Post already deleted");
        return;
      }

      post.deletedAt = new Date();
      post.deletedBy = adminUser.id;
      await post.save();

      set("ok", true);
      set("post", sanitize(post.toObject()));
    },
    { allowUnauth: false }
  )
);

// POST /admin/posts/:id/restore
router.post(
  "/:id/restore",
  route(
    async ({ params, set, setStatus }) => {
      const post = await Post.findOne({ id: decodeURIComponent(params.id) }).select("-attachments");

      if (!post) {
        setStatus(404);
        set("error", "Post not found");
        return;
      }

      post.deletedAt = null;
      post.deletedBy = null;
      if (post.type === "Tombstone") post.type = "Note";
      await post.save();

      await writeFeedItems(post.toObject(), "Post");

      set("ok", true);
      set("post", sanitize(post.toObject()));
    },
    { allowUnauth: false }
  )
);

export default router;
