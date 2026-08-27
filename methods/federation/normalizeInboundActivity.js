// methods/federation/normalizeInboundActivity.js
// Translate a standard ActivityPub activity envelope into our internal format.
//
// Remote servers send AP activities like:
//   { type: "Create", actor: "https://...", object: { type: "Note", ... }, to: [...] }
//
// Our ActivityParser expects:
//   { type: "Create", actorId: "...", objectType: "Post", to: "@public", canReply: "public", ... }

import { getSetting } from "#methods/settings/cache.js";

const AS_PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

// Kowloon actorIds are always "@user@domain" or "@domain" -- no exceptions, even
// for remote AP actors (see activity.schema.js). Remote servers send a raw actor
// URL (e.g. "https://remote.example/users/bob"); convert it to our handle format
// before it ever reaches validation. Assumes the same ".../users/username" path
// convention Kowloon's own actor URLs use -- if a remote actor's URL doesn't fit
// that shape, this falls back to a bare server handle rather than guessing wrong.
function actorRefToHandle(ref) {
  if (!ref) return null;
  const s = String(ref).trim();
  if (s.startsWith("@")) return s; // already our handle format
  try {
    const url = new URL(s);
    const segments = url.pathname.split("/").filter(Boolean);
    const username = segments.at(-1);
    return username ? `@${username}@${url.hostname}` : `@${url.hostname}`;
  } catch {
    return s; // not a URL and not already a handle -- let schema validation reject it
  }
}

// ActivityPub object types → our internal Post type field
const AP_TYPE_TO_POST_TYPE = {
  note:     "Note",
  article:  "Article",
  image:    "Media",
  video:    "Media",
  audio:    "Media",
  document: "Media",
  event:    "Event",
  link:     "Link",
  page:     "Link",
};

// ActivityPub object types → our objectType
const AP_TYPE_TO_OBJECT_TYPE = {
  note:     "Post",
  article:  "Post",
  image:    "Post",
  video:    "Post",
  audio:    "Post",
  document: "Post",
  event:    "Post",
  link:     "Post",
  page:     "Post",
  person:   "User",
  group:    "Group",
  service:  "User",
};

/**
 * Resolve AP `to`/`cc` arrays to our single-string visibility value.
 * Returns one of: "@public" | "@<domain>" | "audience"
 */
function resolveVisibility(to = [], cc = []) {
  const all = [...(Array.isArray(to) ? to : [to]), ...(Array.isArray(cc) ? cc : [cc])].filter(Boolean);
  if (all.includes(AS_PUBLIC)) return "@public";

  const domain = getSetting("domain");
  if (domain && all.some(t => t.includes(domain))) return `@${domain}`;

  return "audience";
}

/**
 * Strip HTML tags and decode entities from AP `content` (which is HTML).
 * Stores raw HTML in source.content with mediaType text/html.
 */
function normalizeContent(obj) {
  if (!obj) return obj;
  const out = { ...obj };

  const html = out.content ?? out.contentMap?.en ?? "";
  if (html) {
    if (!out.source) out.source = {};
    if (!out.source.content) {
      out.source.content = html;
      out.source.mediaType = "text/html";
      out.source.contentEncoding = "utf-8";
    }
  }

  return out;
}

/**
 * Normalize an AP object embedded in Create/Update.
 */
function normalizeApObject(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = normalizeContent(obj);

  // Normalize actorId: AP uses attributedTo
  if (!out.actorId && out.attributedTo) {
    const attributedRef = typeof out.attributedTo === "string"
      ? out.attributedTo
      : out.attributedTo?.id;
    out.actorId = actorRefToHandle(attributedRef);
  }

  // Map published/updated to our timestamps
  if (out.published && !out.createdAt) out.createdAt = new Date(out.published);
  if (out.updated && !out.updatedAt)   out.updatedAt = new Date(out.updated);

  // Map url from AP arrays/objects to string
  if (Array.isArray(out.url)) out.url = out.url[0]?.href ?? out.url[0];
  if (out.url && typeof out.url === "object") out.url = out.url.href ?? null;

  // Map AP image to our image field
  if (out.image && typeof out.image === "object") {
    out.image = out.image.url ?? out.image.href ?? null;
  }
  if (Array.isArray(out.attachment)) {
    // Real AS2 attachment objects (from a Kowloon peer post-#53, or any AP
    // server) carry mediaType/name alongside the url — preserve them instead
    // of discarding everything but the url. resolveAttachments() uses these
    // as a fallback when the local File record isn't hydrated yet.
    out.attachments = out.attachment
      .map(a => {
        const url = a?.url ?? a?.href ?? null;
        if (!url) return null;
        return {
          url,
          ...(a?.mediaType ? { mediaType: a.mediaType } : {}),
          ...(a?.name ? { name: a.name } : {}),
        };
      })
      .filter(Boolean);
    delete out.attachment;
  }

  // AP inReplyTo is an array or string
  if (Array.isArray(out.inReplyTo)) out.inReplyTo = out.inReplyTo[0] ?? null;

  return out;
}

/**
 * Translate a raw AP activity from a remote server into our internal format.
 * Returns a new object; does not mutate the input.
 */
export default function normalizeInboundActivity(apActivity) {
  if (!apActivity || typeof apActivity !== "object") return apActivity;

  // Quick exit: already in our format (has objectType set, no @context)
  if (apActivity.objectType && !apActivity["@context"]) return apActivity;

  const act = { ...apActivity };

  // --- actorId: AP uses `actor` field (URL string or object) ---
  if (!act.actorId) {
    const actor = act.actor;
    const actorRef = typeof actor === "string" ? actor : actor?.id ?? null;
    act.actorId = actorRefToHandle(actorRef);
  }

  // --- objectType: infer from embedded object type or top-level type ---
  if (!act.objectType && act.object && typeof act.object === "object") {
    const apType = (act.object.type ?? "").toLowerCase();
    act.objectType = AP_TYPE_TO_OBJECT_TYPE[apType] ?? null;

    // Also map to our Post `type` subfield if needed
    if (act.objectType === "Post" && !act.object.type?.match(/^(Note|Article|Media|Event|Link)$/)) {
      act.object = { ...act.object, type: AP_TYPE_TO_POST_TYPE[apType] ?? "Note" };
    }
  }

  // --- to / visibility ---
  const rawTo = act.to ?? [];
  const rawCc = act.cc ?? [];
  const vis = resolveVisibility(rawTo, rawCc);

  // Only set if not already set in our format (e.g., "@public")
  if (!act.to || Array.isArray(act.to) || act.to.startsWith("http")) {
    act.to = vis;
  }

  // --- canReply / canReact: default based on visibility ---
  if (act.canReply === undefined) {
    act.canReply = vis === "@public" ? "public" : "audience";
  }
  if (act.canReact === undefined) {
    act.canReact = vis === "@public" ? "public" : "audience";
  }

  // --- Normalize embedded object for Create/Update ---
  if (act.object && typeof act.object === "object") {
    act.object = normalizeApObject(act.object);
    // Copy visibility down if not set on object
    if (!act.object.to || Array.isArray(act.object.to)) {
      act.object.to = act.to;
    }
    if (!act.object.canReply) act.object.canReply = act.canReply;
    if (!act.object.canReact) act.object.canReact = act.canReact;
  }

  // --- Timestamps ---
  if (act.published && !act.publishedAt) act.publishedAt = new Date(act.published);

  // --- Clean up AP-specific fields we've consumed ---
  // Keep @context for downstream use but remove arrays we've normalized
  delete act.cc;

  return act;
}
