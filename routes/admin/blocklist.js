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
} from "#methods/moderation/blocklist.js";

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
  handle(async ({ body, set, setStatus }) => {
    const result = await addToList({
      list: body?.list,
      target: body?.target,
      summary: body?.summary,
      confirmBan: body?.confirmBan === true,
    });
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
  handle(async ({ params, set }) => {
    const id = await removeFromList({ list: params.list, id: decodeURIComponent(params.id) });
    set("ok", true);
    set("id", id);
  })
);

export default router;
