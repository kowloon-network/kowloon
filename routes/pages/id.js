// routes/pages/id.js
// GET /pages/:id — Single page by ID or slug.
// With ?domain=<remote> it server-hydrates the page from that origin Kowloon
// server (a cached shadow), so the app can open remote pages in-app (#74).

import route from "../utils/route.js";
import { Page } from "#schema";
import isLocalDomain from "#methods/parse/isLocalDomain.js";
import { hydrateRemotePage } from "#methods/pages/hydrateRemotePage.js";
import { enrichAttachments } from "#methods/files/enrichAttachments.js";
import { getViewerContext } from "#methods/visibility/context.js";
import { canSeeObject } from "#methods/visibility/helpers.js";

export default route(async ({ req, params, query, user, set, setStatus }) => {
  const idOrSlug = decodeURIComponent(params.id);
  const domain = typeof query?.domain === "string" ? query.domain : null;

  // Remote page — pull a shadow from the origin server (only for known Kowloon
  // hosts; the hydrate method enforces that).
  if (domain && !isLocalDomain(domain)) {
    const remote = await hydrateRemotePage(domain, idOrSlug);
    if (!remote) {
      setStatus(404);
      set("error", "Page not found");
      return;
    }
    set("item", remote);
    return;
  }

  // Local: by id first, then by slug.
  const page =
    (await Page.findOne({ id: idOrSlug, deletedAt: null }).lean()) ||
    (await Page.findOne({ slug: idOrSlug, deletedAt: null }).lean());

  // SECURITY: honour the page's `to` (GET /pages only ever listed @public
  // pages, but this route served any page to anyone who knew its slug).
  // 404 rather than 403 so a restricted page's existence isn't confirmed.
  if (page && !(await canSeeObject(page, await getViewerContext(user?.id || null)))) {
    setStatus(404);
    set("error", "Page not found");
    return;
  }

  if (!page) {
    setStatus(404);
    set("error", "Page not found");
    return;
  }

  const protocol = req.headers["x-forwarded-proto"] || "https";
  await enrichAttachments([page], { protocol });

  set("item", page);
});
