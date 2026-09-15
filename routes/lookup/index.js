// routes/lookup/index.js
// GET /lookup?id=<kowloon id> — the local→remote counterpart of /resolve.
//
// Auth-required. An authenticated local user asks their own server to resolve
// ANY object by its Kowloon id — local, already-cached, or fetched fresh from a
// remote server (hydrated + cached). Works for users, posts, circles, and
// groups (the id encodes the type). Servers keep their own resource route,
// GET /servers/:domain (own FederatedServer cache), so they're out of scope here.
//
// /resolve = serve OUR objects to others (local-only, anon/signature).
// /lookup  = fetch a remote object for our user (hydrate+cache, auth required).
//
// Now backs the "paste any Kowloon ID/link and go there" search feature —
// i.e. this is a real user-facing endpoint taking arbitrary user-typed
// input, not just a trusted internal helper. Visibility is fully enforced
// (see the comment inline below); rate limited via lookupRateLimiter.

import express from "express";
import route from "../utils/route.js";
import getObjectById from "#methods/core/getObjectById.js";
import sanitizeObject from "#methods/sanitize/object.js";
import { getViewerContext } from "#methods/visibility/context.js";
import { canSeeObject } from "#methods/visibility/helpers.js";
import { lookupRateLimiter } from "../middleware/rateLimiter.js";

const router = express.Router({ mergeParams: true });

router.get(
  "/",
  lookupRateLimiter,
  route(
    async ({ req, query, set, setStatus }) => {
      const id = typeof query.id === "string" ? query.id.trim() : "";
      if (!id) {
        setStatus(400);
        set("error", "Missing 'id' query parameter");
        return;
      }

      try {
        // getObjectById defaults enforceLocalVisibility to true, but this
        // route explicitly overrode it to false and passed no canView, so
        // canView fell back to getObjectById's own `async () => true`. Any
        // authenticated user could fetch any local object regardless of its
        // `to` visibility — a real hole the moment /lookup became reachable
        // from a user-typed "go to any ID" search box, since every existing
        // caller was trusted internal code passing an id it already knew the
        // viewer could see (e.g. resolving a circle member).
        //
        // Two things had to be fixed together, not just canView: this route
        // also never passed `viewerId` into getObjectById at all. With
        // enforceLocalVisibility on and viewerId missing, getObjectById's
        // internal `!viewerId && enforceLocalVisibility` branch treats every
        // request as anonymous regardless of who's actually logged in —
        // caught by a test where the true OWNER of a circle-restricted post
        // got refused their own content. viewerId has to be threaded through
        // explicitly; it isn't inferred from anything else in this function.
        const viewerId = req.user?.id || null;
        const viewer = await getViewerContext(viewerId);
        const result = await getObjectById(id, {
          mode: "prefer-local",
          hydrateRemoteIntoDB: true,
          maxStaleSeconds: 300,
          viewerId,
          enforceLocalVisibility: true,
          canView: async (vid, doc) => canSeeObject(doc, viewer),
        });

        if (!result?.object) {
          setStatus(404);
          set("error", "Not found");
          return;
        }

        const objectType = result.object.objectType || result.object.type;
        set("item", sanitizeObject(result.object, { objectType, viewer }));
      } catch (err) {
        const code =
          err?.name === "NotFound" ? 404 :
          err?.name === "NotAuthorized" ? 403 :
          err?.name === "BadRequest" ? 400 :
          err?.name === "UpstreamError" ? 502 : 500;
        setStatus(code);
        set("error", err.message || "Lookup failed");
      }
    },
    { allowUnauth: false }
  )
);

export default router;
