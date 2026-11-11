// routes/bookmarks/server.js
// GET /bookmarks/server — server-owned bookmarks/folders for the sidebar
// tree, viewer-scoped. Two-step query (root items, then their direct
// children) rather than extending GET /bookmarks, because that route
// deliberately stays root-only so folder-visibility inheritance can't be
// bypassed -- buildVisibilityQuery checks a doc's own `to` in isolation,
// with no ancestor-folder awareness. Since server bookmarks are
// policy-capped to one level of nesting (see
// assertAdminBookmarkParentIsTopLevel), "the root Folder passed visibility"
// is equivalent to a full ancestor-chain check here, so no need for the
// heavier canSeeFolderChain machinery this route would otherwise need.

import route from "../utils/route.js";
import { Bookmark } from "#schema";
import { getSetting } from "#methods/settings/cache.js";
import { getViewerContext } from "#methods/visibility/context.js";
import { buildVisibilityQuery } from "#methods/visibility/filter.js";

const SELECT =
  "id type title summary href target image tags to parentFolder order actorId url createdAt updatedAt";

function getServerActorId() {
  const domain = getSetting("domain");
  return getSetting("actorId") || `@${domain}`;
}

export default route(async ({ query, user, set }) => {
  const ctx = await getViewerContext(user?.id || null);
  const actorId = getServerActorId();
  const limit = Math.min(Math.max(1, parseInt(query.limit, 10) || 50), 100);

  const roots = await Bookmark.find({
    $and: [
      buildVisibilityQuery(ctx),
      { actorId, parentFolder: { $in: [null, undefined] } },
    ],
  })
    .select(SELECT)
    .sort({ order: 1, createdAt: -1 })
    .limit(limit)
    .lean();

  const folderIds = roots.filter((r) => r.type === "Folder").map((r) => r.id);

  const children = folderIds.length
    ? await Bookmark.find({
        $and: [
          buildVisibilityQuery(ctx),
          { actorId, parentFolder: { $in: folderIds } },
        ],
      })
        .select(SELECT)
        .sort({ order: 1, createdAt: -1 })
        .lean()
    : [];

  set("items", [...roots, ...children]);
});
