// routes/admin/circles.js
// Admin view + CRUD for circles.
// GET / and GET /:id — list/inspect any circle (user or server owned).
// POST / — create a server-owned circle.
// PATCH /:id — update a server-owned circle.
// DELETE /:id — soft-delete a server-owned circle (?fullDelete=true for hard delete).
// POST /:id/restore — un-delete a server-owned circle.
//
// User-owned circles are managed by their owners via POST /outbox. Admin can
// inspect and delete any circle but cannot edit user-owned ones via this route.

import express from "express";
import route from "../utils/route.js";
import makeCollection from "../utils/makeCollection.js";
import { Circle } from "#schema";
import { getSetting } from "#methods/settings/cache.js";
import { getServerActor } from "#methods/settings/schemaHelpers.js";

const router = express.Router({ mergeParams: true });

const ALLOWED_FIELDS = ["name", "summary", "icon", "to", "canReply", "canReact"];

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

// GET /admin/circles
router.get(
  "/",
  makeCollection({
    model: Circle,
    buildQuery: (req, { query }) => {
      const filter = {};
      if (query.type) {
        filter.type = query.type;
      } else {
        filter.type = "Circle";
      }
      if (query.actorId) filter.actorId = query.actorId;
      // ?server=true — only server-owned circles
      if (query.server === "true") filter.actorId = getServerActorId();
      if (query.to) {
        filter.to = query.to;
      } else if (query.visibility !== "all") {
        // Admin sees public/server circles by default; pass ?visibility=all for private ones too.
        // Without this, every user's private System circles addressed to themselves (e.g. "Following" --
        // type "Circle", not "System", so the type filter above doesn't catch it -- see schema/User.js)
        // showed up in this list.
        const domain = getSetting("domain");
        filter.to = { $in: ["@public", `@${domain}`] };
      }
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

// GET /admin/circles/:id
router.get(
  "/:id",
  route(
    async ({ params, set, setStatus }) => {
      const circle = await Circle.findOne({
        id: decodeURIComponent(params.id),
      })
        .select("-signature")
        .lean();

      if (!circle) {
        setStatus(404);
        set("error", "Circle not found");
        return;
      }
      set("circle", sanitize(circle));
    },
    { allowUnauth: false }
  )
);

// POST /admin/circles — create a server-owned circle
router.post(
  "/",
  route(
    async ({ body, set, setStatus }) => {
      if (!body.name?.trim()) {
        setStatus(400);
        set("error", "name is required");
        return;
      }

      const fields = pick(body, ALLOWED_FIELDS);
      if (!fields.to) fields.to = "@public";

      const circle = await Circle.create({
        ...fields,
        type: "Circle",
        actorId: getServerActorId(),
        actor: getServerActor(),
      });

      setStatus(201);
      set("circle", sanitize(circle.toObject()));
    },
    { allowUnauth: false }
  )
);

// PATCH /admin/circles/:id — update a server-owned circle
router.patch(
  "/:id",
  route(
    async ({ params, body, set, setStatus }) => {
      const circle = await Circle.findOne({
        id: decodeURIComponent(params.id),
        deletedAt: null,
      });

      if (!circle) {
        setStatus(404);
        set("error", "Circle not found");
        return;
      }

      if (circle.actorId !== getServerActorId()) {
        setStatus(403);
        set("error", "Only server-owned circles can be edited via this endpoint");
        return;
      }

      const fields = pick(body, ALLOWED_FIELDS);
      Object.assign(circle, fields);
      await circle.save();

      set("ok", true);
      set("circle", sanitize(circle.toObject()));
    },
    { allowUnauth: false }
  )
);

// DELETE /admin/circles/:id — soft-delete (default) or hard-delete (?fullDelete=true)
router.delete(
  "/:id",
  route(
    async ({ params, query, user: adminUser, set, setStatus }) => {
      const circle = await Circle.findOne({
        id: decodeURIComponent(params.id),
      });

      if (!circle) {
        setStatus(404);
        set("error", "Circle not found");
        return;
      }

      if (circle.actorId !== getServerActorId()) {
        setStatus(403);
        set("error", "Only server-owned circles can be deleted via this endpoint");
        return;
      }

      if (query.fullDelete === "true") {
        await Circle.deleteOne({ id: circle.id });
        set("ok", true);
        set("hardDeleted", true);
        return;
      }

      if (circle.deletedAt) {
        setStatus(409);
        set("error", "Circle already deleted");
        return;
      }

      circle.deletedAt = new Date();
      circle.deletedBy = adminUser.id;
      await circle.save();

      set("ok", true);
      set("circle", sanitize(circle.toObject()));
    },
    { allowUnauth: false }
  )
);

// POST /admin/circles/:id/restore
router.post(
  "/:id/restore",
  route(
    async ({ params, set, setStatus }) => {
      const circle = await Circle.findOne({
        id: decodeURIComponent(params.id),
      });

      if (!circle) {
        setStatus(404);
        set("error", "Circle not found");
        return;
      }

      circle.deletedAt = null;
      circle.deletedBy = null;
      await circle.save();

      set("ok", true);
      set("circle", sanitize(circle.toObject()));
    },
    { allowUnauth: false }
  )
);

export default router;
