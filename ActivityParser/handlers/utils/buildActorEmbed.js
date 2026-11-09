// ActivityParser/handlers/utils/buildActorEmbed.js
//
// SECURITY: the `actor` embed stored on a Post/Page/Circle/Group/Reply is what
// every reader renders as "who wrote this". It used to be copied from the
// client-supplied `activity.actor`, so a local user could publish under any
// other user's name and avatar. For LOCAL (outbox-origin) activities we now
// always build it server-side from the authenticated actor's User doc.
//
// Inbound federated activities (`activity._federation`, set only by
// routes/inbox/post.js after HTTP-signature verification; the outbox strips
// it from client bodies) keep the remote server's embed, since the remote
// actor has no local User doc and the signing server is the authority for it.

import { User } from "#schema";
import { getServerSettings, getServerActor } from "#methods/settings/schemaHelpers.js";

export function isInboundFederated(activity) {
  return Boolean(activity && activity._federation && activity._federation.keyId);
}

// Domain of a Kowloon id ("post:x@domain", "@user@domain") or an http(s) URL.
export function domainOfId(id) {
  if (typeof id !== "string" || !id) return null;
  if (/^https?:\/\//i.test(id)) {
    try { return new URL(id).hostname.toLowerCase(); } catch { return null; }
  }
  const at = id.lastIndexOf("@");
  if (at === -1) return null;
  return id.slice(at + 1).toLowerCase() || null;
}

export function signerDomain(activity) {
  const keyId = activity?._federation?.keyId;
  if (!keyId) return null;
  try { return new URL(keyId).hostname.toLowerCase(); } catch { return null; }
}

/**
 * Build the actor embed for `activity.actorId`.
 * @returns {Promise<object>} embed (possibly `{}` if the actor can't be found)
 */
export default async function buildActorEmbed(activity) {
  if (isInboundFederated(activity)) {
    const a = activity.actor;
    if (a && typeof a === "object" && a.id) return a;
    return activity.actorId ? { id: activity.actorId } : {};
  }

  const actorId = activity?.actorId;
  if (!actorId) return {};
  const { actorId: serverActorId, domain } = getServerSettings();
  if (actorId === serverActorId) return getServerActor() || {};

  const actorDoc = await User.findOne({ id: actorId })
    .select("id type username profile url inbox outbox server")
    .lean();
  if (!actorDoc) return {};
  return {
    id: actorDoc.id,
    type: actorDoc.type ?? "Person",
    name: actorDoc.profile?.name ?? actorDoc.username,
    icon: actorDoc.profile?.icon ?? null,
    url: actorDoc.url ?? `https://${domain}/users/${actorDoc.id}`,
    inbox: actorDoc.inbox,
    outbox: actorDoc.outbox,
    server: actorDoc.server ?? `@${domain}`,
  };
}
