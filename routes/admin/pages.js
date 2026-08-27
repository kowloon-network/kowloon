// routes/admin/pages.js — Admin CRUD for server Pages
import express from "express";
import route from "../utils/route.js";
import makeCollection from "../utils/makeCollection.js";
import { Page, FeedItems } from "#schema";
import { getSetting } from "#methods/settings/cache.js";
import { getServerActor } from "#methods/settings/schemaHelpers.js";
import resolveAttachments from "#methods/files/resolveAttachment.js";

const router = express.Router({ mergeParams: true });

// Fields admins can set on create/update
const ALLOWED_FIELDS = [
  "type", "title", "slug", "summary", "parentId", "order",
  "source", "image", "attachments", "tags", "to", "canReply", "canReact", "href",
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

router.get(
  "/",
  makeCollection({
    model: Page,
    buildQuery: (req, { query }) => {
      const filter = {};
      if (query.deleted === "true") {
        filter.deletedAt = { $ne: null };
      } else if (query.deleted !== "include") {
        filter.deletedAt = null;
      }
      if (query.type) filter.type = query.type;
      if (query.parentId) filter.parentId = query.parentId;
      return filter;
    },
    select: "-signature",
    sort: { order: 1, createdAt: -1 },
    sanitize,
    routeOpts: { allowUnauth: false },
  })
);

// GET /admin/pages/:id
router.get(
  "/:id",
  route(
    async ({ params, set, setStatus }) => {
      const idOrSlug = decodeURIComponent(params.id);
      const page = await Page.findOne({
        $or: [{ id: idOrSlug }, { slug: idOrSlug }],
        deletedAt: null,
      })
        .select("-signature")
        .lean();

      if (!page) {
        setStatus(404);
        set("error", "Page not found");
        return;
      }
      set("page", sanitize(page));
    },
    { allowUnauth: false }
  )
);

// POST /admin/pages — create
router.post(
  "/",
  route(
    async ({ body, user: adminUser, set, setStatus }) => {
      if (!body.title) {
        setStatus(400);
        set("error", "title is required");
        return;
      }

      const domain = getSetting("domain");
      const serverActorId = getSetting("actorId") || `@${domain}`;

      const fields = pick(body, ALLOWED_FIELDS);

      // Default visibility to public if not specified
      if (!fields.to) fields.to = "@public";

      if (fields.attachments) {
        fields.attachments = await resolveAttachments(fields.attachments);
      }

      const page = await Page.create({
        ...fields,
        actorId: serverActorId,
        actor: getServerActor(),
      });

      setStatus(201);
      set("page", sanitize(page.toObject()));
    },
    { allowUnauth: false }
  )
);

// PATCH /admin/pages/:id — update
router.patch(
  "/:id",
  route(
    async ({ params, body, user: adminUser, set, setStatus }) => {
      const idOrSlug = decodeURIComponent(params.id);
      const page = await Page.findOne({
        $or: [{ id: idOrSlug }, { slug: idOrSlug }],
        deletedAt: null,
      });

      if (!page) {
        setStatus(404);
        set("error", "Page not found");
        return;
      }

      const fields = pick(body, ALLOWED_FIELDS);
      if (fields.attachments) {
        fields.attachments = await resolveAttachments(fields.attachments);
      }
      Object.assign(page, fields);
      // Clear wordCount/charCount so pre-save hook recalculates them
      page.wordCount = 0;
      page.charCount = 0;
      await page.save();

      set("ok", true);
      set("page", sanitize(page.toObject()));
    },
    { allowUnauth: false }
  )
);

// DELETE /admin/pages/:id — soft-delete (default) or hard-delete (?fullDelete=true)
router.delete(
  "/:id",
  route(
    async ({ params, query, user: adminUser, set, setStatus }) => {
      const idOrSlug = decodeURIComponent(params.id);
      const page = await Page.findOne({
        $or: [{ id: idOrSlug }, { slug: idOrSlug }],
      });

      if (!page) {
        setStatus(404);
        set("error", "Page not found");
        return;
      }

      if (query.fullDelete === "true") {
        await FeedItems.deleteMany({ id: page.id });
        await Page.deleteOne({ id: page.id });
        set("ok", true);
        set("hardDeleted", true);
        return;
      }

      if (page.deletedAt) {
        setStatus(409);
        set("error", "Page already deleted");
        return;
      }

      page.deletedAt = new Date();
      page.deletedBy = adminUser.id;
      await page.save();

      set("ok", true);
      set("page", sanitize(page.toObject()));
    },
    { allowUnauth: false }
  )
);

// POST /admin/pages/:id/restore
router.post(
  "/:id/restore",
  route(
    async ({ params, set, setStatus }) => {
      const idOrSlug = decodeURIComponent(params.id);
      const page = await Page.findOne({
        $or: [{ id: idOrSlug }, { slug: idOrSlug }],
      });

      if (!page) {
        setStatus(404);
        set("error", "Page not found");
        return;
      }

      page.deletedAt = null;
      page.deletedBy = null;
      await page.save();

      set("ok", true);
      set("page", sanitize(page.toObject()));
    },
    { allowUnauth: false }
  )
);

export default router;
