// methods/auth/staffPolicy.js -- what moderators may do. Admins may do
// everything in the admin panel; moderators only what's listed here.
// Anything not listed is admin-only (default deny).
//
// Agreed with Josh 2026-11-13:
//
//                                             Moderator   Admin
//   Reports: see, ignore, remove, delete        yes        yes
//   Block a remote person or server             yes        yes
//   Defederate / un-defederate a server         yes (1)    yes
//   Close / restore a member's account          yes        yes
//   Ban a member (permanent deletion)           no         yes
//   Banned emails, Blocked-list visibility      no         yes
//   Users list                                  view       yes
//   Pages, Bookmarks, Discover, server Circles  add/edit   yes
//     ...deleting any of them                   no (2)     yes
//   Invites, Themes, Settings, Logs, Groups
//     and Posts admin, creating users           no         yes
//
//   (1) every admin is notified, with who did it and why.
//   (2) taking an entry off a Discover shelf only un-features it, so
//       moderators may do that.
//
// Plus: a moderator can't act against an admin or another moderator
// (remove their content, block or close their account) -- that's an
// admin's call. Every action records who took it.

import { Settings, Circle } from "#schema";
import isServerAdmin from "#methods/auth/isServerAdmin.js";
import createNotification from "#methods/notifications/create.js";

// Read straight from the DB, like isServerAdmin: after a restore the
// settings cache can be stale.
async function circleHas(settingName, actorId) {
  if (!actorId) return false;
  const s = await Settings.findOne({ name: settingName }).lean();
  if (!s?.value) return false;
  return !!(await Circle.exists({ id: s.value, "members.id": actorId }));
}

export async function isServerModerator(actorId) {
  return circleHas("modCircle", actorId);
}

// "admin" | "mod" | null. An admin who is also in the mod circle is an admin.
export async function staffRole(actorId) {
  if (!actorId) return null;
  if (await isServerAdmin(actorId)) return "admin";
  if (await isServerModerator(actorId)) return "mod";
  return null;
}

export async function isStaff(actorId) {
  return !!(await staffRole(actorId));
}

// Admin API routes a moderator may call: [METHOD, path under /admin].
const MOD_ROUTES = [
  // Dashboard figures
  ["GET", /^\/system\/?$/],
  // Reports
  ["GET", /^\/flagged(\/[^/]+)?\/?$/],
  ["POST", /^\/flagged\/[^/]+\/(ignore|remove|hard-delete|block)\/?$/],
  // Blocked / Defederated lists (bans, email lists and list visibility are
  // refused below or in the route)
  ["GET", /^\/blocklist\/?$/],
  ["POST", /^\/blocklist\/?$/],
  ["PATCH", /^\/blocklist\/(blocked|defederated)\/[^/]+\/?$/],
  ["DELETE", /^\/blocklist\/(blocked|defederated)\/[^/]+\/?$/],
  // Users: view, close (soft delete), restore
  ["GET", /^\/users(\/[^/]+)?\/?$/],
  ["DELETE", /^\/users\/[^/]+\/?$/],
  ["POST", /^\/users\/[^/]+\/restore\/?$/],
  // Pages and Bookmarks: add, edit, reorder (no delete)
  ["GET", /^\/(pages|bookmarks)(\/[^/]+)?\/?$/],
  ["POST", /^\/(pages|bookmarks)\/?$/],
  ["POST", /^\/(pages|bookmarks)\/reorder\/?$/],
  ["PATCH", /^\/(pages|bookmarks)\/[^/]+\/?$/],
  // Discover: feature, edit, un-feature; shelves: add and edit
  ["GET", /^\/(discovery|sections)(\/[^/]+)?\/?$/],
  ["POST", /^\/discovery\/?$/],
  ["POST", /^\/discovery\/[^/]+\/restore\/?$/],
  ["PATCH", /^\/(discovery|sections)\/[^/]+\/?$/],
  ["DELETE", /^\/discovery\/[^/]+\/?$/],
  ["POST", /^\/sections\/?$/],
  // Server circles: add and edit (no delete)
  ["GET", /^\/circles(\/[^/]+)?\/?$/],
  ["POST", /^\/circles\/?$/],
  ["PATCH", /^\/circles\/[^/]+\/?$/],
];

export function modMayUse(method, path) {
  const m = String(method || "").toUpperCase();
  const p = String(path || "").split("?")[0];
  // The blocklist's own sub-paths that look like /:list/:id but aren't.
  if (/^\/blocklist\/(emails|[^/]+\/visibility)(\/|$)/.test(p)) return false;
  return MOD_ROUTES.some(([rm, re]) => rm === m && re.test(p));
}

// Ids of every admin and moderator.
export async function staffIds({ adminsOnly = false } = {}) {
  const names = adminsOnly ? ["adminCircle"] : ["adminCircle", "modCircle"];
  const settings = await Settings.find({ name: { $in: names } }).lean();
  const circleIds = settings.map((s) => s.value).filter(Boolean);
  if (!circleIds.length) return [];
  const circles = await Circle.find({ id: { $in: circleIds } }).select("members.id").lean();
  return [...new Set(circles.flatMap((c) => (c.members || []).map((m) => m.id)))];
}

// Notify admins (and moderators, unless adminsOnly). Skips `except` (usually
// the person who caused it).
export async function notifyStaff({ actorId, summary, href, adminsOnly = false, except = [] }) {
  const skip = new Set([actorId, ...except].filter(Boolean));
  const ids = (await staffIds({ adminsOnly })).filter((id) => !skip.has(id));
  await Promise.all(
    ids.map((recipientId) =>
      createNotification({ type: "moderation", recipientId, actorId, summary, href }).catch(() => null)
    )
  );
  return ids.length;
}
