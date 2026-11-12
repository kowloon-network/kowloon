// methods/moderation/federationPolicy.js -- what the server's Blocked and
// Defederated lists mean for federation. Every federation path asks here;
// none reads FederatedServer.status for moderation.
//
// Agreed with Josh 2026-11-12:
//
//                                Blocked server  Defederated   Blocked person
//   their posts come in          yes (1)         no            yes (1)
//   their replies/reactions      refused         refused       refused
//   they read us (signed GETs)   yes             no            no
//   we deliver to them           yes             no            no
//   members fetch by link        yes             no            yes
//   members add them to circles  yes             no            yes
//   visitor sign-in from them    yes             no            no
//   their stored content         shown           hidden        hidden (2)
//   search + Discover            hidden          hidden        hidden
//
//   (1) only for members who follow them -- "we don't control who our users
//       read, only who can interact with us on our own server".
//   (2) hidden from shared surfaces (community feeds, threads, search,
//       Discover); still shown to a member who has them in a circle.
//
// Inbound interaction refusals live in routes/inbox/post.js; the lists
// themselves in ./blocklist.js.

import { getBlockSets, isActorBlocked } from "./blocklist.js";

// Domain of any id we deal in: "@user@domain", "@domain", "post:x@domain",
// "https://domain/...", or a bare "domain".
export function domainOf(id) {
  if (!id || typeof id !== "string") return null;
  const s = id.trim().toLowerCase();
  if (/^https?:\/\//.test(s)) {
    try {
      return new URL(s).hostname;
    } catch {
      return null;
    }
  }
  const at = s.lastIndexOf("@");
  if (at !== -1) return s.slice(at + 1) || null;
  return /^[a-z0-9.-]+\.[a-z]{2,}(:\d+)?$/.test(s) ? s : null;
}

export async function isDefederated(idOrDomain) {
  const domain = domainOf(idOrDomain);
  if (!domain) return false;
  const { defederatedServers } = await getBlockSets();
  return defederatedServers.has(domain);
}

export async function isServerBlocked(idOrDomain) {
  const domain = domainOf(idOrDomain);
  if (!domain) return false;
  const { blockedServers } = await getBlockSets();
  return blockedServers.has(domain);
}

// A person id (or actor URL) on the server Blocked list.
export { isActorBlocked as isPersonBlocked };

// May we send an activity to this recipient? `target` is a person id or
// "@domain", `host` the inbox's host.
export async function canDeliverTo({ target, host } = {}) {
  if (await isDefederated(host || target)) return false;
  if (target && target.split("@").length === 3 && (await isActorBlocked(target))) return false;
  return true;
}

// May this remote requester read from us (signed GETs, file fetches, lookups,
// visitor sign-in)? `domain` is the requesting server, `actorId` the person
// when known. Returns a reason string when refused, null when allowed.
export async function refusalForRequester({ domain, actorId } = {}) {
  if (domain && (await isDefederated(domain))) return "This server has defederated from yours";
  if (actorId && (await isDefederated(actorId))) return "This server has defederated from yours";
  if (actorId && (await isActorBlocked(actorId))) return "You are blocked on this server";
  return null;
}

// May we fetch something from wherever this id/URL lives?
export async function canFetchFrom(idOrUrl) {
  return !(await isDefederated(idOrUrl));
}

// Mongo filter excluding objects authored on defederated servers or by
// blocked people -- for shared surfaces (community feeds, threads, search).
// `field` is the author id field (actorId on most models).
export async function hiddenAuthorsFilter(field = "actorId") {
  const { blockedActors, defederatedServers } = await getBlockSets();
  const clauses = [];
  if (blockedActors.size) clauses.push({ [field]: { $nin: [...blockedActors] } });
  if (defederatedServers.size) {
    const re = [...defederatedServers].map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    clauses.push({ [field]: { $not: new RegExp(`@(${re})$`, "i") } });
  }
  return clauses.length ? { $and: clauses } : {};
}

// Same rule for one already-loaded object (or its author id).
export async function isHiddenAuthor(actorId) {
  if (!actorId) return false;
  if (await isDefederated(actorId)) return true;
  return isActorBlocked(actorId);
}
