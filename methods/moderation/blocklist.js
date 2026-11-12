// methods/moderation/blocklist.js
// Server-level block lists. Two system circles owned by the server actor,
// named in Settings like adminCircle/modCircle:
//
//   blockedCircle      People (local or remote) and servers we won't
//                      interact with. Private by default (addressed to the
//                      admin circle); an admin can make it public to share it.
//                        - a LOCAL person here is BANNED: their account and
//                          all their content are permanently deleted (we
//                          can't keep a disabled account the person can no
//                          longer delete), their username stays reserved by
//                          this membership, and their email goes on the
//                          bannedEmails list. Last resort.
//                        - a REMOTE person: everything they send us is
//                          refused at the inbox.
//                        - a SERVER: its replies and reactions are refused;
//                          its posts still come in for members who follow
//                          people there (FederatedServer.status "blocked").
//   defederatedCircle  Servers we cut off completely: nothing in, nothing
//                      out, hidden from search and discovery
//                      (FederatedServer.status "suspended"). Private by
//                      default. Stricter than Blocked; a server is only ever
//                      on one of the two lists.
//
// Every member entry can carry a `summary` -- the reason it's on the list.
// It's visible to whoever can see the circle, so on a public Blocked list
// it's a public statement.
//
// The circles are what admins see and edit. FederatedServer.status stays as
// the fast per-server lookup the inbox, search and discovery already use,
// and is kept in step here. Membership is also cached in memory (short TTL,
// since the app and the workers are separate processes) for the inbox check.

import { Circle, FederatedServer, OAuthRefreshToken, Settings, User, VisitingIdentity } from "#schema";
import { getSetting } from "#methods/settings/cache.js";
import deleteAccountCascade from "#methods/users/deleteAccountCascade.js";
import isServerAdmin from "#methods/auth/isServerAdmin.js";

export const LISTS = {
  blocked: { setting: "blockedCircle", name: "Blocked" },
  defederated: { setting: "defederatedCircle", name: "Defederated" },
};

const SUMMARY_MAX = 1000;

export class BlocklistError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function serverActorId() {
  return getSetting("actorId") || `@${getSetting("domain")}`;
}

function ownDomain() {
  return getSetting("domain");
}

function cleanSummary(summary) {
  if (typeof summary !== "string") return undefined;
  const s = summary.trim();
  return s ? s.slice(0, SUMMARY_MAX) : undefined;
}

// ---- Circles -----------------------------------------------------------

// The admin circle's id -- "private" for these lists means addressed to it.
async function adminCircleId() {
  const s = await Settings.findOne({ name: "adminCircle" }).lean();
  return s?.value || "";
}

// Find (or create, once) the circle for a list. Read from the DB, not the
// settings cache, so a just-created circle is seen by every process.
export async function getListCircle(list) {
  const def = LISTS[list];
  if (!def) throw new BlocklistError("Unknown list");
  const setting = await Settings.findOne({ name: def.setting }).lean();
  if (setting?.value) {
    const circle = await Circle.findOne({ id: setting.value });
    if (circle) return circle;
  }
  const circle = await Circle.create({
    type: "System",
    name: def.name,
    actorId: serverActorId(),
    to: await adminCircleId(),
    canReact: "",
    canReply: "",
  });
  // The app and the workers start at the same time; only one may claim the
  // setting. The loser deletes its circle and uses the winner's.
  const claimed = await Settings.findOneAndUpdate(
    { name: def.setting, $or: [{ value: "" }, { value: null }, { value: { $exists: false } }] },
    { $set: { value: circle.id } },
    { new: true }
  ).lean();
  if (claimed?.value === circle.id) return circle;
  if (!claimed && !setting) {
    // No setting row at all yet (defaults not seeded) -- create it.
    await Settings.updateOne({ name: def.setting }, { $setOnInsert: { value: circle.id } }, { upsert: true });
    const now = await Settings.findOne({ name: def.setting }).lean();
    if (now?.value === circle.id) return circle;
  }
  await Circle.deleteOne({ id: circle.id });
  const winner = await Settings.findOne({ name: def.setting }).lean();
  return Circle.findOne({ id: winner?.value });
}

// ---- In-memory lookup for the hot paths (inbox, signup) ---------------------

const TTL_MS = 60 * 1000;
let cache = null; // { at, blockedActors:Set, blockedServers:Set, defederatedServers:Set }

export function invalidateBlocklistCache() {
  cache = null;
}

export async function getBlockSets() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  const [blocked, defed] = await Promise.all([
    getListCircle("blocked"),
    getListCircle("defederated"),
  ]);
  const blockedActors = new Set();
  const blockedServers = new Set();
  for (const m of blocked.members || []) {
    if (isServerId(m.id)) blockedServers.add(m.id.slice(1));
    else blockedActors.add(m.id);
  }
  const defederatedServers = new Set(
    (defed.members || []).map((m) => m.id).filter(isServerId).map((id) => id.slice(1))
  );
  cache = { at: Date.now(), blockedActors, blockedServers, defederatedServers };
  return cache;
}

// Is this actor (a person's @user@domain id) on the server Blocked list?
// Accepts "@user@domain" or an actor URL ("https://domain/users/user").
export async function isActorBlocked(actorId) {
  if (!actorId || typeof actorId !== "string") return false;
  let id = actorId.toLowerCase();
  if (/^https?:\/\//.test(id)) {
    try {
      const u = new URL(id);
      const name = u.pathname.split("/").filter(Boolean).pop();
      id = name ? `@${name.replace(/^@/, "")}@${u.hostname}` : id;
    } catch {
      return false;
    }
  }
  const { blockedActors } = await getBlockSets();
  return blockedActors.has(id);
}

// ---- Targets ------------------------------------------------------------

// "@domain" (a server) vs "@user@domain" (a person).
export function isServerId(id) {
  return typeof id === "string" && /^@[^@\s]+$/.test(id);
}

// Accepts "@user@domain", "user@domain" for people, and "example.org",
// "@example.org", "https://example.org/..." for servers.
export function normalizeTarget(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  if (/^https?:\/\//.test(s)) {
    try {
      s = new URL(s).hostname;
    } catch {
      return null;
    }
  }
  if (s.startsWith("@")) s = s.slice(1);
  const parts = s.split("@");
  const valid = (d) => /^[a-z0-9.-]+\.[a-z]{2,}$|^localhost(:\d+)?$/.test(d);
  if (parts.length === 1) {
    return valid(parts[0]) ? { kind: "server", id: `@${parts[0]}`, domain: parts[0] } : null;
  }
  if (parts.length === 2 && /^[a-z0-9_.-]+$/.test(parts[0]) && valid(parts[1])) {
    return { kind: "person", id: `@${parts[0]}@${parts[1]}`, domain: parts[1], username: parts[0] };
  }
  return null;
}

async function memberFor(target, summary) {
  if (target.kind === "server") {
    const fs = await FederatedServer.findOne({ domain: target.domain })
      .select("name profile")
      .lean();
    return {
      id: target.id,
      type: "Server",
      name: fs?.profile?.name || fs?.name || target.domain,
      icon: fs?.profile?.icon || undefined,
      url: `https://${target.domain}`,
      server: target.id,
      summary: cleanSummary(summary),
    };
  }
  const u = await User.findOne({ id: target.id })
    .select("id username profile.name profile.icon url inbox outbox")
    .lean();
  return {
    id: target.id,
    type: "Person",
    name: u?.profile?.name || u?.username || target.username,
    icon: u?.profile?.icon || undefined,
    url: u?.url || undefined,
    inbox: u?.inbox || undefined,
    outbox: u?.outbox || undefined,
    server: `@${target.domain}`,
    summary: cleanSummary(summary),
  };
}

async function addMember(list, member) {
  const circle = await getListCircle(list);
  const now = new Date();
  // Replace any existing entry for the same id, so re-adding updates it.
  await Circle.updateOne({ id: circle.id }, { $pull: { members: { id: member.id } } });
  await Circle.updateOne(
    { id: circle.id },
    { $push: { members: { ...member, createdAt: now, updatedAt: now } }, $set: { updatedAt: now } }
  );
  await syncMemberCount(circle.id);
}

async function removeMember(list, id) {
  const circle = await getListCircle(list);
  const res = await Circle.updateOne(
    { id: circle.id, "members.id": id },
    { $pull: { members: { id } }, $set: { updatedAt: new Date() } }
  );
  await syncMemberCount(circle.id);
  return res.modifiedCount > 0;
}

async function syncMemberCount(circleId) {
  const c = await Circle.findOne({ id: circleId }).select("members").lean();
  await Circle.updateOne({ id: circleId }, { $set: { memberCount: c?.members?.length || 0 } });
}

// ---- Banned emails --------------------------------------------------------

export function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

async function readList(name) {
  const s = await Settings.findOne({ name }).lean();
  return Array.isArray(s?.value) ? s.value : [];
}

async function writeList(name, value) {
  await Settings.updateOne({ name }, { $set: { value } }, { upsert: true });
}

export async function getBannedEmails() {
  const [emails, domains] = await Promise.all([
    readList("bannedEmails"),
    readList("bannedEmailDomains"),
  ]);
  return { emails, domains };
}

// kind: "email" | "domain"
export async function addBannedEmail({ kind, value, note }) {
  const name = kind === "domain" ? "bannedEmailDomains" : "bannedEmails";
  let v = normalizeEmail(value);
  if (kind === "domain") {
    v = v.replace(/^@/, "");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) throw new BlocklistError("Enter an email domain, e.g. example.com");
  } else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) {
    throw new BlocklistError("Enter an email address");
  }
  const list = (await readList(name)).filter((e) => e.value !== v);
  list.unshift({ value: v, note: cleanSummary(note) || null, addedAt: new Date().toISOString() });
  await writeList(name, list);
  return v;
}

export async function removeBannedEmail({ kind, value }) {
  const name = kind === "domain" ? "bannedEmailDomains" : "bannedEmails";
  let v = normalizeEmail(value);
  if (kind === "domain") v = v.replace(/^@/, "");
  const list = await readList(name);
  const next = list.filter((e) => e.value !== v);
  await writeList(name, next);
  return next.length !== list.length;
}

// Is this email (or its domain) banned? Used at signup, email change, and
// individual invites.
export async function isEmailBanned(email) {
  const v = normalizeEmail(email);
  if (!v || !v.includes("@")) return false;
  const domain = v.split("@").pop();
  const { emails, domains } = await getBannedEmails();
  return emails.some((e) => e.value === v) || domains.some((d) => d.value === domain);
}

// Is this local username reserved by a ban?
export async function isUsernameBanned(username) {
  const domain = ownDomain();
  if (!username || !domain) return false;
  const { blockedActors } = await getBlockSets();
  return blockedActors.has(`@${String(username).toLowerCase()}@${domain}`);
}

// ---- The admin actions ----------------------------------------------------

// Add a person or server to a list.
//   list: "blocked" | "defederated"
//   target: see normalizeTarget()
//   confirmBan: must be true to ban a LOCAL person (permanent deletion)
export async function addToList({ list, target: rawTarget, summary, confirmBan = false }) {
  if (!LISTS[list]) throw new BlocklistError("Unknown list");
  const target = normalizeTarget(rawTarget);
  if (!target) throw new BlocklistError("Enter a server (example.org) or a person (@name@example.org)");

  const domain = ownDomain();

  if (target.kind === "server") {
    if (target.domain === domain) throw new BlocklistError("You can't block your own server");
    const member = await memberFor(target, summary);
    const other = list === "blocked" ? "defederated" : "blocked";
    await removeMember(other, target.id);
    await addMember(list, member);
    // Keep the fast per-server lookup in step.
    if (list === "defederated") {
      await FederatedServer.suspendServer(target.domain, member.summary);
      // End visits from there and our members' sign-ins to there.
      await VisitingIdentity.deleteMany({ homeDomain: target.domain });
      await OAuthRefreshToken.updateMany(
        { clientDomain: target.domain, revokedAt: null },
        { revokedAt: new Date() }
      );
    } else await FederatedServer.blockServer(target.domain, member.summary);
    invalidateBlocklistCache();
    return { member, banned: false };
  }

  // People only go on the Blocked list.
  if (list !== "blocked") {
    throw new BlocklistError("Only servers can be defederated. To stop a person, add them to Blocked.");
  }

  if (target.domain === domain) {
    // A local person: this is a ban -- permanent deletion.
    const user = await User.findOne({ id: target.id }).select("id username email profile").lean();
    if (!confirmBan) {
      throw new BlocklistError(
        "Banning someone on this server permanently deletes their account and everything they posted. Confirm to continue.",
        409
      );
    }
    if (user && (await isServerAdmin(user.id))) {
      throw new BlocklistError("Remove their admin rights before banning them.", 403);
    }
    const member = await memberFor(target, summary);
    if (user) {
      const result = await deleteAccountCascade(user.id, { purgeContent: true });
      if (!result?.ok) throw new BlocklistError(result?.error || "Couldn't delete the account", 409);
      if (user.email) {
        await addBannedEmail({
          kind: "email",
          value: user.email,
          note: `Banned account ${target.id}${member.summary ? ` -- ${member.summary}` : ""}`,
        }).catch(() => {});
      }
    }
    // Added AFTER the cascade, which pulls the person from every circle.
    await addMember("blocked", member);
    invalidateBlocklistCache();
    return { member, banned: true };
  }

  // A remote person.
  const member = await memberFor(target, summary);
  await addMember("blocked", member);
  await VisitingIdentity.deleteMany({ userId: target.id }); // ends any visit
  invalidateBlocklistCache();
  return { member, banned: false };
}

export async function removeFromList({ list, id: rawId }) {
  if (!LISTS[list]) throw new BlocklistError("Unknown list");
  const target = normalizeTarget(rawId);
  if (!target) throw new BlocklistError("Unknown entry");
  const removed = await removeMember(list, target.id);
  if (!removed) throw new BlocklistError("That isn't on the list", 404);
  if (target.kind === "server") {
    // Clear both, whatever status says: blockedAt/suspendedAt are what the
    // startup sync (migrateServerBlocks) reads to restore lost blocks.
    await FederatedServer.unsuspendServer(target.domain);
    await FederatedServer.unblockServer(target.domain);
  }
  invalidateBlocklistCache();
  return target.id;
}

export async function updateSummary({ list, id: rawId, summary }) {
  if (!LISTS[list]) throw new BlocklistError("Unknown list");
  const target = normalizeTarget(rawId);
  if (!target) throw new BlocklistError("Unknown entry");
  const circle = await getListCircle(list);
  const s = cleanSummary(summary);
  const res = await Circle.updateOne(
    { id: circle.id, "members.id": target.id },
    s
      ? { $set: { "members.$.summary": s, "members.$.updatedAt": new Date() } }
      : { $unset: { "members.$.summary": "" }, $set: { "members.$.updatedAt": new Date() } }
  );
  if (!res.matchedCount) throw new BlocklistError("That isn't on the list", 404);
  if (target.kind === "server") {
    const field = list === "defederated" ? "suspendedReason" : "blockedReason";
    await FederatedServer.updateOne({ domain: target.domain }, { $set: { [field]: s || null } });
  }
  return s || null;
}

// Blocked can be shared: public = "@public", private = the admin circle.
export async function setListVisibility({ list, isPublic }) {
  if (!LISTS[list]) throw new BlocklistError("Unknown list");
  const circle = await getListCircle(list);
  const to = isPublic ? "@public" : await adminCircleId();
  await Circle.updateOne({ id: circle.id }, { $set: { to, updatedAt: new Date() } });
  return { to, isPublic: !!isPublic };
}

export async function getLists() {
  const out = {};
  for (const list of Object.keys(LISTS)) {
    const c = await getListCircle(list);
    out[list] = {
      circleId: c.id,
      isPublic: c.to === "@public",
      members: [...(c.members || [])]
        .map((m) => (m.toObject ? m.toObject() : m))
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)),
    };
  }
  return out;
}

// Startup sync, both directions.
//
// 1. Any server blocked or suspended via the old Moderation > Servers records
//    gets a matching circle entry. blockedAt/suspendedAt count too: before
//    2026-11-12 a successful pull or profile fetch reset status to "active"
//    without clearing them, so they are the surviving record of a block the
//    bug silently undid. (unblockServer/unsuspendServer clear them, so a real
//    unblock is never resurrected.)
// 2. Every server on either list gets the matching FederatedServer status,
//    which the older enforcement paths still read.
export async function migrateServerBlocks() {
  const docs = await FederatedServer.find({
    $or: [
      { status: { $in: ["blocked", "suspended"] } },
      { blockedAt: { $ne: null } },
      { suspendedAt: { $ne: null } },
    ],
  })
    .select("domain name profile status blockedAt suspendedAt blockedReason suspendedReason")
    .lean();
  const added = await addMissingServerEntries(docs);
  await syncServerStatuses();
  return added;
}

async function addMissingServerEntries(docs) {
  if (!docs.length) return 0;
  const [blocked, defed] = await Promise.all([getListCircle("blocked"), getListCircle("defederated")]);
  const has = (c, id) => (c.members || []).some((m) => m.id === id);
  let added = 0;
  for (const d of docs) {
    const id = `@${d.domain}`;
    if (has(blocked, id) || has(defed, id)) continue;
    const list = d.status === "suspended" || d.suspendedAt ? "defederated" : "blocked";
    const circle = list === "defederated" ? defed : blocked;
    if (has(circle, id)) continue;
    await addMember(list, {
      id,
      type: "Server",
      name: d.profile?.name || d.name || d.domain,
      url: `https://${d.domain}`,
      server: id,
      summary: cleanSummary(list === "defederated" ? d.suspendedReason : d.blockedReason),
    });
    added++;
  }
  invalidateBlocklistCache();
  return added;
}

// Make FederatedServer.status match the lists: listed servers get
// blocked/suspended; a server marked blocked/suspended but on neither list
// is left alone here (step 1 above has just listed it).
async function syncServerStatuses() {
  const { blockedServers, defederatedServers } = await getBlockSets();
  for (const domain of defederatedServers) {
    await FederatedServer.updateOne(
      { domain, status: { $ne: "suspended" } },
      { $set: { status: "suspended", nextPullAt: null } }
    );
  }
  for (const domain of blockedServers) {
    await FederatedServer.updateOne(
      { domain, status: { $nin: ["blocked", "suspended"] } },
      { $set: { status: "blocked" } }
    );
  }
}
