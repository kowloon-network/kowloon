// routes/groups/posts.js
// GET /groups/:id/posts — Posts addressed to a group.
//
// Access control is enforced on the Group record; the FeedItems query
// uses the `group` field which is always populated for group-addressed posts.

import route from "../utils/route.js";
import { Group, FeedItems, Circle } from "#schema";
import { activityStreamsCollection } from "../utils/oc.js";
import feedItemToPost from "#methods/feed/feedItemToPost.js";
import { enrichAttachments } from "#methods/files/enrichAttachments.js";
import { getSetting } from "#methods/settings/cache.js";
import isLocalDomain from "#methods/parse/isLocalDomain.js";
import kowloonId from "#methods/parse/kowloonId.js";

export default route(async ({ req, params, query, user, set, setStatus }) => {
  const groupId = decodeURIComponent(params.id);
  const group   = await Group.findOne({ id: groupId, deletedAt: null }).lean();

  if (!group) {
    setStatus(404);
    set("error", "Group not found");
    return;
  }

  const domain  = getSetting("domain");
  const toValue = (group.to || "").toLowerCase().trim();

  // Determine viewer locality
  let isLocal = false;
  if (user?.id) {
    const parsed = kowloonId(user.id);
    isLocal = parsed.domain && isLocalDomain(parsed.domain);
  }

  // Access control
  if (toValue !== "@public") {
    if (!user?.id) {
      setStatus(401);
      set("error", "Authentication required");
      return;
    }
    if (toValue === `@${domain}` && !isLocal) {
      setStatus(403);
      set("error", "Access denied");
      return;
    }
    // Private group: verify membership
    if (toValue !== `@${domain}` && group.circles?.members) {
      const membersCircle = await Circle.findOne({
        id: group.circles.members,
        "members.id": user.id,
      }).lean();
      if (!membersCircle) {
        setStatus(403);
        set("error", "Access denied");
        return;
      }
    }
  }

  const page  = Math.max(1, parseInt(query.page,  10) || 1);
  const limit = Math.min(Math.max(1, parseInt(query.limit, 10) || 20), 100);
  const skip  = (page - 1) * limit;

  const filter = {
    group: groupId,
    tombstoned: { $ne: true },
    objectType: "Post",
  };
  if (query.type)  filter.type        = query.type;
  // ?kind=photo|video|audio|file (comma-separated) — e.g. ?type=Media&kind=photo
  // returns only posts with a photo attachment. Backed by the
  // {objectType,type,"object.attachments.kind"} FeedItems index.
  const kinds = query.kind
    ? String(query.kind).split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  if (kinds?.length) {
    filter["object.attachments.kind"] = { $in: kinds };
  }
  if (query.since) filter.publishedAt = { $gte: new Date(query.since) };

  const [docs, total] = await Promise.all([
    FeedItems.find(filter).sort({ publishedAt: -1 }).skip(skip).limit(limit).lean(),
    FeedItems.countDocuments(filter),
  ]);

  const items = docs.map((doc) => {
    const item = feedItemToPost(doc);
    // When filtering by kind, only show the matching attachment(s) — "show
    // just the photos", not the photo plus whatever else is on the post.
    if (kinds?.length && item.attachments?.length) {
      item.attachments = item.attachments.filter((a) => kinds.includes(a?.kind));
    }
    return item;
  });

  const protocol = req.headers["x-forwarded-proto"] || "https";
  // Resolve file:/proxy-URL image + attachments to client URLs + mediaType (#49).
  await enrichAttachments(items, { protocol });
  const base     = `${protocol}://${domain}/groups/${encodeURIComponent(groupId)}/posts`;

  const collection = activityStreamsCollection({
    id: `${base}?page=${page}`,
    orderedItems: items,
    totalItems: total,
    page,
    itemsPerPage: limit,
    baseUrl: base,
  });

  for (const [key, value] of Object.entries(collection)) {
    set(key, value);
  }
});
