// routes/admin/users.js
import express from "express";
import route from "../utils/route.js";
import makeCollection from "../utils/makeCollection.js";
import { User } from "#schema";
import { getSetting } from "#methods/settings/cache.js";

const router = express.Router({ mergeParams: true });

function sanitize(doc) {
  const { _id, __v, password, privateKey, publicKeyJwk, signature, ...rest } = doc;
  return rest;
}

router.get(
  "/",
  makeCollection({
    model: User,
    buildQuery: (req, { query }) => {
      const filter = {};
      if (query.active !== undefined) filter.active = query.active !== "false";
      if (query.deleted === "true") {
        filter.deletedAt = { $ne: null };
      } else if (query.deleted !== "include") {
        filter.deletedAt = null;
      }
      // Regex substring match, not $text -- $text is word-tokenised and won't
      // match partial words like "jzell" against "jzellis" (same reasoning as
      // routes/search/index.js's own User search). Matches display name,
      // username, and the full "@username@domain" id.
      const term = query.search?.trim();
      if (term) {
        const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        filter.$or = [{ "profile.name": re }, { username: re }, { id: re }];
      }
      return filter;
    },
    select: "-password -privateKey -publicKeyJwk -signature",
    sort: { createdAt: -1 },
    sanitize,
    routeOpts: { allowUnauth: false },
  })
);

// GET /admin/users/:id
router.get(
  "/:id",
  route(
    async ({ params, set, setStatus }) => {
      const user = await User.findOne({
        id: decodeURIComponent(params.id),
      })
        .select("-password -privateKey -publicKeyJwk -signature")
        .lean();

      if (!user) {
        setStatus(404);
        set("error", "User not found");
        return;
      }
      set("user", sanitize(user));
    },
    { allowUnauth: false }
  )
);

// DELETE /admin/users/:id — soft-delete (default) or hard-delete (?fullDelete=true)
router.delete(
  "/:id",
  route(
    async ({ params, query, user: adminUser, set, setStatus }) => {
      const target = await User.findOne({ id: decodeURIComponent(params.id) });

      if (!target) {
        setStatus(404);
        set("error", "User not found");
        return;
      }

      if (query.fullDelete === "true") {
        await User.deleteOne({ id: target.id });
        set("ok", true);
        set("hardDeleted", true);
        return;
      }

      if (target.deletedAt) {
        setStatus(409);
        set("error", "User already deleted");
        return;
      }

      target.deletedAt = new Date();
      target.active = false;
      await target.save();

      set("ok", true);
      set("user", sanitize(target.toObject()));
    },
    { allowUnauth: false }
  )
);

// POST /admin/users/:id/restore — un-delete
router.post(
  "/:id/restore",
  route(
    async ({ params, set, setStatus }) => {
      const target = await User.findOne({ id: decodeURIComponent(params.id) });

      if (!target) {
        setStatus(404);
        set("error", "User not found");
        return;
      }

      target.deletedAt = null;
      target.active = true;
      await target.save();

      set("ok", true);
      set("user", sanitize(target.toObject()));
    },
    { allowUnauth: false }
  )
);

export default router;
