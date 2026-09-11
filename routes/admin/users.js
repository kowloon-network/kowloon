// routes/admin/users.js
import crypto from "crypto";
import express from "express";
import route from "../utils/route.js";
import makeCollection from "../utils/makeCollection.js";
import { User } from "#schema";
import { getSetting } from "#methods/settings/cache.js";
import getSettings from "#methods/settings/get.js";

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
      // Local users only by default -- remote actors cached here through
      // federation (e.g. a local user adding @jzellis@kwln.city to a circle)
      // get their own User doc with originDomain set to the REMOTE domain
      // (see methods/core/getObjectById.js), not this server's. This admin
      // page is for managing accounts that live on THIS server (deactivate,
      // restore, roles -- none of which make sense for a remote account)
      // -- pass ?origin=all to include cached remote actors too.
      if (query.origin !== "all") {
        filter.originDomain = getSetting("domain");
      }
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

// POST /admin/users — create an account directly, bypassing registration.
//
// Deliberately skips the gates in routes/register/index.js that exist to
// control *self*-signup: registrationIsOpen, invite codes, and the username
// petty-limits. An admin creating an account on someone's behalf is the
// explicit override for those.
//
// It does NOT skip the username slug rule — usernames become part of the
// account id (@user@domain) and actor URL, so a non-slug here produces
// malformed ids that break profile edits and federation.
//
// Password: pass one, or omit it and the server generates a strong one and
// returns it exactly once in the response. Generating matters on a server
// with no SMTP configured, where there is otherwise no way to hand someone
// their credentials.
router.post(
  "/",
  route(
    async ({ body, set, setStatus }) => {
      if (!body || typeof body !== "object") {
        setStatus(400);
        set("error", "Invalid JSON body");
        return;
      }

      const settings = await getSettings();
      const domain = settings?.domain;
      if (!domain) {
        setStatus(500);
        set("error", "Missing settings.domain");
        return;
      }

      const username =
        typeof body.username === "string" ? body.username.trim() : "";
      const email = typeof body.email === "string" ? body.email.trim() : "";
      const name = typeof body.name === "string" ? body.name.trim() : "";

      if (!username) {
        setStatus(400);
        set("error", "username is required");
        return;
      }

      // Same rule as registration — see routes/register/index.js.
      if (!/^[a-z0-9_]{2,32}$/.test(username)) {
        setStatus(400);
        set(
          "error",
          "Username must be 2–32 characters using only lowercase letters, numbers, or underscores (no spaces or capitals). Put their full name in the display name instead."
        );
        return;
      }

      let password =
        typeof body.password === "string" && body.password ? body.password : null;
      const generated = !password;
      if (password && password.length < 8) {
        setStatus(400);
        set("error", "Password must be at least 8 characters");
        return;
      }
      if (generated) {
        // 24 chars of base58-ish alphabet: no look-alike glyphs, so it
        // survives being read aloud or copied by hand.
        const alphabet =
          "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        const bytes = crypto.randomBytes(24);
        password = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
      }

      const expectedId = `@${username}@${domain}`;
      const existing = await User.findOne({
        $or: [{ username }, { id: expectedId }],
      }).lean();
      if (existing) {
        setStatus(409);
        set("error", "User already exists");
        return;
      }

      // User.create (not a raw insert) so the pre-save hook runs: it sets id,
      // actorId, url, server/domain/jwksUrl, generates the RSA keypair, hashes
      // the password, and creates the following/allFollowing/blocked/muted
      // system circles. Skipping it leaves an account that can't federate.
      //
      // emailVerified is forced true: an admin creating the account IS the
      // vouching step, and on a server without SMTP an unverified account
      // could never be verified and so could never log in.
      //
      // acknowledgedRules is intentionally left empty — the person hasn't
      // agreed to anything yet, and recording consent they never gave would
      // be a lie in their own account history.
      const created = await User.create({
        username,
        password,
        ...(email ? { email } : {}),
        ...(name ? { profile: { name } } : {}),
        emailVerified: true,
      });

      setStatus(201);
      set("ok", true);
      set("user", sanitize(created.toObject()));
      // Returned once, never stored in readable form — the pre-save hook has
      // already hashed what's in the database.
      if (generated) set("generatedPassword", password);
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
