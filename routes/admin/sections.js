// routes/admin/sections.js — Admin CRUD for Discover shelves.
import express from "express";
import route from "../utils/route.js";
import { DiscoverySection, Discovery } from "#schema";

const router = express.Router({ mergeParams: true });

const ALLOWED_FIELDS = ["name", "summary", "order", "to", "active"];

function sanitize(doc) {
  const { _id, __v, signature, ...rest } = doc;
  return rest;
}
function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (f in obj) out[f] = obj[f];
  return out;
}

// GET /admin/sections — all shelves (active + inactive), ordered.
router.get(
  "/",
  route(
    async ({ query, set }) => {
      const filter = {};
      if (query.deleted === "true") filter.deletedAt = { $ne: null };
      else if (query.deleted !== "include") filter.deletedAt = null;
      const sections = await DiscoverySection.find(filter)
        .sort({ order: 1, createdAt: 1 })
        .select("-signature")
        .lean();
      set("sections", sections.map(sanitize));
    },
    { allowUnauth: false }
  )
);

// POST /admin/sections — create a shelf.
router.post(
  "/",
  route(
    async ({ body, set, setStatus }) => {
      if (!body.name) {
        setStatus(400);
        set("error", "name is required");
        return;
      }
      const fields = pick(body, ALLOWED_FIELDS);
      if (!fields.to) fields.to = "@public";
      const section = await DiscoverySection.create(fields);
      setStatus(201);
      set("section", sanitize(section.toObject()));
    },
    { allowUnauth: false }
  )
);

// PATCH /admin/sections/:id
router.patch(
  "/:id",
  route(
    async ({ params, body, set, setStatus }) => {
      const id = decodeURIComponent(params.id);
      const section = await DiscoverySection.findOne({ id, deletedAt: null });
      if (!section) {
        setStatus(404);
        set("error", "Section not found");
        return;
      }
      Object.assign(section, pick(body, ALLOWED_FIELDS));
      await section.save();
      set("ok", true);
      set("section", sanitize(section.toObject()));
    },
    { allowUnauth: false }
  )
);

// DELETE /admin/sections/:id — soft-delete (default) or ?fullDelete=true.
// A full delete also removes the shelf's discovery items.
router.delete(
  "/:id",
  route(
    async ({ params, query, user: admin, set, setStatus }) => {
      const id = decodeURIComponent(params.id);
      const section = await DiscoverySection.findOne({ id });
      if (!section) {
        setStatus(404);
        set("error", "Section not found");
        return;
      }
      if (query.fullDelete === "true") {
        await Discovery.deleteMany({ section: id });
        await DiscoverySection.deleteOne({ id });
        set("ok", true);
        set("hardDeleted", true);
        return;
      }
      section.deletedAt = new Date();
      section.deletedBy = admin?.id || null;
      await section.save();
      set("ok", true);
      set("section", sanitize(section.toObject()));
    },
    { allowUnauth: false }
  )
);

export default router;
