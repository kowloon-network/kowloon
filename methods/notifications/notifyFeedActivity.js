// Fire feed / group "new posts" nudges when a Post is created.
//
// Two streams, both throttled + read-gated by createNotification's cooldownMs
// (at most one per 12h per user/key, and never a pile-up while an earlier one
// sits unread):
//   - Feed:  "Your feeds have new posts"  (key "feed", per user) — for public/
//            server posts (author's followers) and circle-addressed posts
//            (the circle's members). Group posts are carved out.
//   - Group: "There are new posts in '<name>'" (key group_posts:<id>, per group).
//
// Opt-in only, via prefs.notifications.new_post. Author never notified of their
// own post (createNotification's self-guard + the exclude below).

import { Circle, Group, User } from "#schema";
import { getServerSettings } from "#methods/settings/schemaHelpers.js";
import createNotification from "./create.js";

const COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12 hours

// Local users among `ids` who opted into new-post notifications, minus the author.
async function optedIn(ids, excludeId) {
  const list = [...new Set(ids)].filter((id) => id && id !== excludeId);
  if (!list.length) return [];
  const users = await User.find({
    id: { $in: list },
    "prefs.notifications.new_post": true,
  })
    .select("id")
    .lean();
  return users.map((u) => u.id);
}

// Users who have blocked or muted `authorId`. Every circle holding the author
// is fetched once; a System circle that is its owner's circles.blocked or
// circles.muted marks that owner as a blocker. Returns the candidate circles
// too so the public-post path can reuse them.
async function circlesHoldingAuthor(authorId) {
  const circles = await Circle.find({ "members.id": authorId })
    .select("id actorId type")
    .lean();
  const systemOwners = [
    ...new Set(circles.filter((c) => c.type === "System").map((c) => c.actorId)),
  ];
  const owners = systemOwners.length
    ? await User.find({ id: { $in: systemOwners } })
        .select("id circles.blocked circles.muted")
        .lean()
    : [];
  const silencingCircleIds = new Set();
  const blockers = new Set();
  const held = new Set(circles.map((c) => c.id));
  for (const u of owners) {
    for (const cid of [u.circles?.blocked, u.circles?.muted]) {
      if (cid && held.has(cid)) {
        silencingCircleIds.add(cid);
        blockers.add(u.id);
      }
    }
  }
  return { circles, silencingCircleIds, blockers };
}

const fetchActor = (id) => User.findOne({ id }).select("id profile").lean();

// Fire the generic feed nudge for users who just received NEW feed content via
// fan-out — the remote half of #75 (a federation pull landing a followed remote
// user's post). `pairs` = [{ userId, actorId }] where actorId is a triggering
// post's author (needed for createNotification's non-self guard). Opt-in
// filtered; throttled/read-gated to one per 12h per user, same as the local nudge.
export async function notifyFeedFanOut(pairs) {
  try {
    const list = (pairs || []).filter(
      (p) => p?.userId && p?.actorId && p.userId !== p.actorId
    );
    if (!list.length) return;
    const opted = new Set(await optedIn(list.map((p) => p.userId), null));
    const actorCache = new Map(); // one actor lookup per author, not per recipient
    for (const { userId, actorId } of list) {
      if (!opted.has(userId)) continue;
      if (!actorCache.has(actorId)) actorCache.set(actorId, await fetchActor(actorId));
      await createNotification({
        type: "new_post",
        recipientId: userId,
        actorId,
        actor: actorCache.get(actorId),
        summary: "Your feeds have new posts",
        groupKey: "feed",
        cooldownMs: COOLDOWN_MS,
      });
    }
  } catch (err) {
    console.error("notifyFeedFanOut failed:", err?.message);
  }
}

export default async function notifyFeedActivity(post) {
  try {
    if (!post?.id || !post?.actorId) return;
    const authorId = post.actorId;
    const to = String(post.to || "").trim();
    const dl = getServerSettings().domain?.toLowerCase();

    const tokens = to.split(/\s+/).filter(Boolean);
    const groupIds = tokens.filter((t) => t.startsWith("group:"));
    const circleIds = tokens.filter((t) => t.startsWith("circle:"));
    const low = to.toLowerCase();
    const isPublicOrServer =
      !to ||
      low === "@public" ||
      low === "public" ||
      low === "@server" ||
      low === "server" ||
      low === `@${dl}`;

    const actor = await fetchActor(authorId);

    // ── GROUP posts → one throttled notification per group ──────────────────
    if (groupIds.length) {
      const groups = await Group.find({ id: { $in: groupIds } })
        .select("id name circles.members")
        .lean();
      for (const g of groups) {
        // Group has no top-level `members`; they live in the Circle at
        // g.circles.members (g.members was always undefined -> nobody notified).
        const membersCircle = g.circles?.members
          ? await Circle.findOne({ id: g.circles.members }).select("members.id").lean()
          : null;
        const recipients = await optedIn((membersCircle?.members || []).map((m) => m.id), authorId);
        for (const recipientId of recipients) {
          await createNotification({
            type: "new_post",
            recipientId,
            actorId: authorId,
            actor,
            objectId: g.id,
            objectType: "Group",
            summary: `There are new posts in "${g.name}"`,
            groupKey: `group_posts:${g.id}`,
            cooldownMs: COOLDOWN_MS,
          });
        }
      }
      return; // group posts belong to the group stream, not the feed nudge
    }

    // ── FEED posts (public / server / circle) → single per-user nudge ───────
    let recipientIds = [];
    if (!isPublicOrServer && !circleIds.length) {
      return; // private (single user) or unrecognized — no feed nudge
    }
    // People who blocked or muted the author never get nudged about them.
    const { circles: holding, silencingCircleIds, blockers } =
      await circlesHoldingAuthor(authorId);
    if (isPublicOrServer) {
      // Followers = local users who have this author in one of their circles
      // -- but a Blocked/Muted system circle is not "following".
      recipientIds = holding
        .filter((c) => !silencingCircleIds.has(c.id))
        .map((c) => c.actorId);
    } else if (circleIds.length) {
      // Circle-addressed → the circle's members (the audience).
      const circles = await Circle.find({ id: { $in: circleIds } })
        .select("members")
        .lean();
      const set = new Set();
      for (const c of circles) for (const m of c.members || []) if (m.id) set.add(m.id);
      recipientIds = [...set];
    }
    recipientIds = recipientIds.filter((id) => !blockers.has(id));

    const recipients = await optedIn(recipientIds, authorId);
    for (const recipientId of recipients) {
      await createNotification({
        type: "new_post",
        recipientId,
        actorId: authorId,
        actor,
        // No objectId → generic "your feeds have new posts"; opens the feed.
        summary: "Your feeds have new posts",
        groupKey: "feed",
        cooldownMs: COOLDOWN_MS,
      });
    }
  } catch (err) {
    console.error("notifyFeedActivity failed:", err?.message);
  }
}
