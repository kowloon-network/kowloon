// routes/admin/discovery.js — Admin CRUD for individual discovery items.
//
// Adding a discovery item validates the target: it must be a curatable type
// (Post/Circle/Group/Bookmark/Page — never a User) and must currently be
// public or server-visible (you can't surface a private object). The target's
// tier is snapshotted into `visibility`; the live target stays authoritative
// at read time.
import express from "express";
import route from "../utils/route.js";
import {
  Discovery,
  DiscoverySection,
  Post,
  Circle,
  Group,
  Bookmark,
  Page,
} from "#schema";
import { refTypeOf } from "#schema/Discovery.js";
import { getSetting } from "#methods/settings/cache.js";

const router = express.Router({ mergeParams: true });
const MODELS = { Post, Circle, Group, Bookmark, Page };

function sanitize(doc) {
  const { _id, __v, signature, ...rest } = doc;
  return rest;
}

function tierOf(to, domain) {
  if (to === "@public" || to === "public") return "public";
  if (to === `@${domain}` || to === "@server" || to === "server") return "server";
  return "private";
}

// GET /admin/discovery?section=<id>&refType=<Type>
router.get(
  "/",
  route(
    async ({ query, set }) => {
      const filter = {};
      if (query.deleted === "true") filter.deletedAt = { $ne: null };
      else if (query.deleted !== "include") filter.deletedAt = null;
      if (query.section) filter.section = query.section;
      if (query.refType) filter.refType = query.refType;
      const items = await Discovery.find(filter)
        .sort({ section: 1, order: 1, createdAt: 1 })
        .select("-signature")
        .lean();
      set("discoveries", items.map(sanitize));
    },
    { allowUnauth: false }
  )
);

// POST /admin/discovery — add one.  Body: { ref, section, note?, order? }
router.post(
  "/",
  route(
    async ({ body, user: admin, set, setStatus }) => {
      const { ref, section } = body;
      if (!ref || !section) {
        setStatus(400);
        set("error", "ref and section are required");
        return;
      }

      const refType = refTypeOf(ref);
      if (!refType) {
        setStatus(400);
        set(
          "error",
          "ref must be a Post, Circle, Group, Bookmark or Page ID (Users can't be surfaced)"
        );
        return;
      }

      const sectionDoc = await DiscoverySection.findOne({
        id: section,
        deletedAt: null,
      }).lean();
      if (!sectionDoc) {
        setStatus(404);
        set("error", "Section not found");
        return;
      }

      // Confirm the target exists and is public/server-visible.
      const target = await MODELS[refType]
        .findOne({ id: ref, deletedAt: null })
        .select("id to")
        .lean();
      if (!target) {
        setStatus(404);
        set("error", "Target object not found on this server");
        return;
      }
      const domain = getSetting("domain");
      const tier = tierOf(target.to, domain);
      if (tier === "private") {
        setStatus(400);
        set("error", "Only public or server-visible objects can be surfaced");
        return;
      }

      const item = await Discovery.create({
        ref,
        section,
        note: body.note,
        order: typeof body.order === "number" ? body.order : 0,
        visibility: tier,
        addedBy: admin?.id,
      });

      setStatus(201);
      set("discovery", sanitize(item.toObject()));
    },
    { allowUnauth: false }
  )
);

// PATCH /admin/discovery/:id — edit note/order/active/section.
router.patch(
  "/:id",
  route(
    async ({ params, body, set, setStatus }) => {
      const id = decodeURIComponent(params.id);
      const item = await Discovery.findOne({ id, deletedAt: null });
      if (!item) {
        setStatus(404);
        set("error", "Discovery item not found");
        return;
      }
      for (const f of ["note", "order", "active", "section"]) {
        if (f in body) item[f] = body[f];
      }
      await item.save();
      set("ok", true);
      set("discovery", sanitize(item.toObject()));
    },
    { allowUnauth: false }
  )
);

// DELETE /admin/discovery/:id — soft-delete (default) or ?fullDelete=true.
router.delete(
  "/:id",
  route(
    async ({ params, query, user: admin, set, setStatus }) => {
      const id = decodeURIComponent(params.id);
      const item = await Discovery.findOne({ id });
      if (!item) {
        setStatus(404);
        set("error", "Discovery item not found");
        return;
      }
      if (query.fullDelete === "true") {
        await Discovery.deleteOne({ id });
        set("ok", true);
        set("hardDeleted", true);
        return;
      }
      item.deletedAt = new Date();
      item.deletedBy = admin?.id || null;
      await item.save();
      set("ok", true);
      set("discovery", sanitize(item.toObject()));
    },
    { allowUnauth: false }
  )
);

export default router;
