// routes/admin/blocklist.js -- the server's Blocked and Defederated lists and
// the banned-email list. See methods/moderation/blocklist.js for what each
// list means and how it's enforced.
//
//   GET    /admin/blocklist                          both lists
//   POST   /admin/blocklist        { list, target, summary, confirmBan }
//   PATCH  /admin/blocklist/:list/:id   { summary }
//   DELETE /admin/blocklist/:list/:id
//   PATCH  /admin/blocklist/:list/visibility   { public: bool }
//   GET    /admin/blocklist/emails
//   POST   /admin/blocklist/emails  { kind: "email"|"domain", value, note }
//   DELETE /admin/blocklist/emails/:kind/:value

import express from "express";
import route from "../utils/route.js";
import {
  BlocklistError,
  addToList,
  removeFromList,
  updateSummary,
  setListVisibility,
  getLists,
  getBannedEmails,
  addBannedEmail,
  removeBannedEmail,
  normalizeTarget,
} from "#methods/moderation/blocklist.js";
import { isDefederated } from "#methods/moderation/federationPolicy.js";
import { isStaff, notifyStaff } from "#methods/auth/staffPolicy.js";
import { getSetting } from "#methods/settings/cache.js";

// ---- Moderator limits (methods/auth/staffPolicy.js) ----------------------
// Moderators can't ban (a local person on Blocked) or unban, can't put staff
// on a list, and every defederation change they make is reported to admins.

function isLocalPerson(target) {
  const domain = String(getSetting("domain") || "").toLowerCase();
  return target?.kind === "person" && target.domain === domain;
}

async function modRefusal(req, list, rawTarget, { removing = false } = {}) {
  if (req.staffRole !== "mod") return null;
  const target = normalizeTarget(rawTarget);
  if (!target) return null; // let the list code explain what's wrong
  if (list === "blocked" && isLocalPerson(target)) {
    return removing
      ? "Only an admin can lift a ban"
      : "Only an admin can ban a member of this server";
  }
  if (!removing && target.kind === "person" && (await isStaff(target.id))) {
    return "Only an admin can block an admin or moderator";
  }
  return null;
}

// Tell every admin when a moderator changes who's defederated.
async function tellAdmins(req, user, text) {
  if (req.staffRole !== "mod") return;
  const domain = getSetting("domain");
  const who = user.profile?.name || user.username || user.id;
  text = text.replace(/^A moderator/, `${who} (moderator)`);
  await notifyStaff({
    actorId: user.id,
    adminsOnly: true,
    summary: text,
    href: `https://${domain}/admin/moderation`,
  });
}

const router = express.Router({ mergeParams: true });

// Run fn; turn a BlocklistError into its status + message.
function handle(fn) {
  return route(
    async (ctx) => {
      try {
        await fn(ctx);
      } catch (err) {
        if (err instanceof BlocklistError) {
          ctx.setStatus(err.status);
          ctx.set("error", err.message);
          return;
        }
        throw err;
      }
    },
    { allowUnauth: false }
  );
}

router.get(
  "/",
  handle(async ({ set }) => {
    const lists = await getLists();
    set("blocked", lists.blocked);
    set("defederated", lists.defederated);
  })
);

// Emails first, so "/emails" isn't read as a :list.
router.get(
  "/emails",
  handle(async ({ set }) => {
    const { emails, domains } = await getBannedEmails();
    set("emails", emails);
    set("domains", domains);
  })
);

router.post(
  "/emails",
  handle(async ({ body, set, setStatus }) => {
    const value = await addBannedEmail({
      kind: body?.kind === "domain" ? "domain" : "email",
      value: body?.value,
      note: body?.note,
    });
    setStatus(201);
    set("ok", true);
    set("value", value);
  })
);

router.delete(
  "/emails/:kind/:value",
  handle(async ({ params, set, setStatus }) => {
    const removed = await removeBannedEmail({
      kind: params.kind === "domain" ? "domain" : "email",
      value: decodeURIComponent(params.value),
    });
    if (!removed) {
      setStatus(404);
      set("error", "That isn't on the list");
      return;
    }
    set("ok", true);
  })
);

router.post(
  "/",
  handle(async ({ req, user, body, set, setStatus }) => {
    const refusal = await modRefusal(req, body?.list, body?.target);
    if (refusal) {
      setStatus(403);
      set("error", refusal);
      return;
    }
    const target = normalizeTarget(body?.target);
    const wasDefederated = target?.kind === "server" && (await isDefederated(target.domain));
    const result = await addToList({
      list: body?.list,
      target: body?.target,
      summary: body?.summary,
      confirmBan: body?.confirmBan === true,
    });
    const why = result.member?.summary ? ` Reason: ${result.member.summary}` : "";
    if (body?.list === "defederated") {
      await tellAdmins(req, user, `A moderator defederated ${target.domain}.${why}`);
    } else if (wasDefederated) {
      await tellAdmins(req, user, `A moderator moved ${target.domain} from Defederated to Blocked, so it's federating again.${why}`);
    }
    setStatus(201);
    set("ok", true);
    set("member", result.member);
    set("banned", result.banned);
  })
);

router.patch(
  "/:list/visibility",
  handle(async ({ params, body, set }) => {
    const r = await setListVisibility({ list: params.list, isPublic: body?.public === true });
    set("ok", true);
    set("isPublic", r.isPublic);
  })
);

router.patch(
  "/:list/:id",
  handle(async ({ params, body, set }) => {
    const summary = await updateSummary({
      list: params.list,
      id: decodeURIComponent(params.id),
      summary: body?.summary,
    });
    set("ok", true);
    set("summary", summary);
  })
);

router.delete(
  "/:list/:id",
  handle(async ({ req, user, params, set, setStatus }) => {
    const rawId = decodeURIComponent(params.id);
    const refusal = await modRefusal(req, params.list, rawId, { removing: true });
    if (refusal) {
      setStatus(403);
      set("error", refusal);
      return;
    }
    const id = await removeFromList({ list: params.list, id: rawId });
    if (params.list === "defederated") {
      await tellAdmins(req, user, `A moderator lifted the defederation of ${String(id).replace(/^@/, "")}.`);
    }
    set("ok", true);
    set("id", id);
  })
);

export default router;
