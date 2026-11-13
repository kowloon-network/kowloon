// routes/admin/bookmarks.js — Admin CRUD for server-owned bookmarks
//
// Server-owned bookmarks reuse the normal Bookmark/Folder model -- the only
// difference is actorId is the server's own actor id instead of a user's,
// and `to` is restricted to @public or @<domain> (no circle/group scoping,
// unlike a personal bookmark). Nesting is capped at exactly one level: a
// top-level Folder may contain Bookmarks, but never another Folder -- see
// assertAdminBookmarkParentIsTopLevel.
import express from "express";
import route from "../utils/route.js";
import makeCollection from "../utils/makeCollection.js";
import { Bookmark } from "#schema";
import { getSetting } from "#methods/settings/cache.js";
import { getServerActor } from "#methods/settings/schemaHelpers.js";
import { assertAdminBookmarkParentIsTopLevel } from "#methods/bookmarks/visibility.js";

const router = express.Router({ mergeParams: true });

const ALLOWED_FIELDS = [
  "title", "summary", "type", "href", "target", "image", "tags", "to", "parentFolder", "order",
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

// Only @public or this server's own @<domain> handle -- no circle/group
// scoping for server-owned bookmarks, even though Bookmark.to technically
// supports it.
function isAllowedTo(to, domain) {
  return to === "@public" || to === `@${domain}`;
}

router.get(
  "/",
  makeCollection({
    model: Bookmark,
    buildQuery: (req, { query }) => {
      const filter = { actorId: getServerActorId() };
      if (query.deleted === "true") {
        filter.deletedAt = { $ne: null };
      } else if (query.deleted !== "include") {
        filter.deletedAt = null;
      }
      if (query.type) filter.type = query.type;
      return filter;
    },
    select: "-signature",
    sort: { order: 1, createdAt: -1 },
    sanitize,
    routeOpts: { allowUnauth: false },
  })
);

// POST /admin/bookmarks/reorder -- body { ids: [...] }: the new order of one set
// of siblings (same parentFolder), top first. Each gets order = its index.
// Every id must be a bookmarksS with that same parent (server-owned only).
router.post(
  "/reorder",
  route(
    async ({ body, set, setStatus }) => {
      const ids = Array.isArray(body?.ids) ? body.ids.filter((x) => typeof x === "string") : [];
      if (!ids.length || ids.length > 500 || new Set(ids).size !== ids.length) {
        setStatus(400);
        set("error", "ids must be a non-empty list of distinct ids");
        return;
      }
      const docs = await Bookmark.find({ id: { $in: ids }, actorId: getServerActorId() }).select("id parentFolder").lean();
      if (docs.length !== ids.length) {
        setStatus(400);
        set("error", "Some of those items don't exist");
        return;
      }
      const parents = new Set(docs.map((d) => d.parentFolder || null));
      if (parents.size !== 1) {
        setStatus(400);
        set("error", "Items can only be reordered among their siblings");
        return;
      }
      await Bookmark.bulkWrite(
        ids.map((id, i) => ({ updateOne: { filter: { id }, update: { $set: { order: i } } } }))
      );
      set("ok", true);
    },
    { allowUnauth: false }
  )
);

// GET /admin/bookmarks/:id
router.get(
  "/:id",
  route(
    async ({ params, set, setStatus }) => {
      const bookmark = await Bookmark.findOne({
        id: decodeURIComponent(params.id),
        actorId: getServerActorId(),
      })
        .select("-signature")
        .lean();

      if (!bookmark) {
        setStatus(404);
        set("error", "Bookmark not found");
        return;
      }
      set("bookmark", sanitize(bookmark));
    },
    { allowUnauth: false }
  )
);

// POST /admin/bookmarks — create a server-owned bookmark or folder
router.post(
  "/",
  route(
    async ({ user, body, set, setStatus }) => {
      if (!body.title?.trim()) {
        setStatus(400);
        set("error", "title is required");
        return;
      }

      const type = body.type === "Folder" ? "Folder" : "Bookmark";
      if (type === "Bookmark" && !body.href?.trim() && !body.target?.trim()) {
        setStatus(400);
        set("error", "href or target is required for a Bookmark");
        return;
      }

      const domain = getSetting("domain");
      const fields = pick(body, ALLOWED_FIELDS);
      fields.type = type;
      if (!fields.to) fields.to = "@public";
      if (!isAllowedTo(fields.to, domain)) {
        setStatus(400);
        set("error", `to must be "@public" or "@${domain}"`);
        return;
      }

      if (fields.parentFolder) {
        if (type === "Folder") {
          setStatus(400);
          set("error", "Server bookmarks support only one level of folder nesting -- a Folder cannot itself have a parentFolder");
          return;
        }
        try {
          await assertAdminBookmarkParentIsTopLevel(fields.parentFolder);
        } catch (err) {
          setStatus(400);
          set("error", err.message);
          return;
        }
      }

      const bookmark = await Bookmark.create({
        ...fields,
        lastEditedBy: user.id,
        actorId: getServerActorId(),
        actor: getServerActor(),
      });

      setStatus(201);
      set("bookmark", sanitize(bookmark.toObject()));
    },
    { allowUnauth: false }
  )
);

// PATCH /admin/bookmarks/:id — update a server-owned bookmark or folder
router.patch(
  "/:id",
  route(
    async ({ user, params, body, set, setStatus }) => {
      const bookmark = await Bookmark.findOne({
        id: decodeURIComponent(params.id),
        deletedAt: null,
      });

      if (!bookmark) {
        setStatus(404);
        set("error", "Bookmark not found");
        return;
      }

      if (bookmark.actorId !== getServerActorId()) {
        setStatus(403);
        set("error", "Only server-owned bookmarks can be edited via this endpoint");
        return;
      }

      const domain = getSetting("domain");
      const fields = pick(body, ALLOWED_FIELDS);

      if ("to" in fields && !isAllowedTo(fields.to, domain)) {
        setStatus(400);
        set("error", `to must be "@public" or "@${domain}"`);
        return;
      }

      if ("parentFolder" in fields && fields.parentFolder) {
        const effectiveType = fields.type ?? bookmark.type;
        if (effectiveType === "Folder") {
          setStatus(400);
          set("error", "Server bookmarks support only one level of folder nesting -- a Folder cannot itself have a parentFolder");
          return;
        }
        try {
          await assertAdminBookmarkParentIsTopLevel(fields.parentFolder);
        } catch (err) {
          setStatus(400);
          set("error", err.message);
          return;
        }
      }

      Object.assign(bookmark, fields);
      bookmark.lastEditedBy = user.id;
      await bookmark.save();

      set("ok", true);
      set("bookmark", sanitize(bookmark.toObject()));
    },
    { allowUnauth: false }
  )
);

// DELETE /admin/bookmarks/:id — soft-delete (default) or hard-delete
// (?fullDelete=true). Cascades to a Folder's direct children so they never
// end up orphaned and permanently unreachable (no route surfaces a bookmark
// whose parent folder no longer exists).
router.delete(
  "/:id",
  route(
    async ({ params, query, user: adminUser, set, setStatus }) => {
      const bookmark = await Bookmark.findOne({ id: decodeURIComponent(params.id) });

      if (!bookmark) {
        setStatus(404);
        set("error", "Bookmark not found");
        return;
      }

      if (bookmark.actorId !== getServerActorId()) {
        setStatus(403);
        set("error", "Only server-owned bookmarks can be edited via this endpoint");
        return;
      }

      const fullDelete = query.fullDelete === "true";
      const children = bookmark.type === "Folder"
        ? await Bookmark.find({ parentFolder: bookmark.id })
        : [];

      if (fullDelete) {
        if (children.length) {
          await Bookmark.deleteMany({ id: { $in: children.map((c) => c.id) } });
        }
        await Bookmark.deleteOne({ id: bookmark.id });
        set("ok", true);
        set("hardDeleted", true);
        return;
      }

      if (bookmark.deletedAt) {
        setStatus(409);
        set("error", "Bookmark already deleted");
        return;
      }

      const now = new Date();
      if (children.length) {
        await Bookmark.updateMany(
          { id: { $in: children.map((c) => c.id) }, deletedAt: null },
          { $set: { deletedAt: now, deletedBy: adminUser.id } }
        );
      }
      bookmark.deletedAt = now;
      bookmark.deletedBy = adminUser.id;
      await bookmark.save();

      set("ok", true);
      set("bookmark", sanitize(bookmark.toObject()));
    },
    { allowUnauth: false }
  )
);

// POST /admin/bookmarks/:id/restore
router.post(
  "/:id/restore",
  route(
    async ({ params, set, setStatus }) => {
      const bookmark = await Bookmark.findOne({ id: decodeURIComponent(params.id) });

      if (!bookmark) {
        setStatus(404);
        set("error", "Bookmark not found");
        return;
      }

      if (bookmark.actorId !== getServerActorId()) {
        setStatus(403);
        set("error", "Only server-owned bookmarks can be edited via this endpoint");
        return;
      }

      bookmark.deletedAt = null;
      bookmark.deletedBy = null;
      await bookmark.save();

      set("ok", true);
      set("bookmark", sanitize(bookmark.toObject()));
    },
    { allowUnauth: false }
  )
);

export default router;
