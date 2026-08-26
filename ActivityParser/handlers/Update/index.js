// /ActivityParser/handlers/Update/index.js

import bcrypt from "bcryptjs";
import {
  Bookmark,
  Circle,
  Group,
  Page,
  Post,
  React as ReactModel,
  Reply,
  User,
  FeedItems,
} from "#schema";
import kowloonId from "#methods/parse/kowloonId.js";
import { canonicalTo } from "#methods/parse/canonicalTo.js";
import isServerAdmin from "#methods/auth/isServerAdmin.js";
import getFederationTargetsHelper from "../utils/getFederationTargets.js";
import refreshActorCache from "#methods/users/refreshActorCache.js";
import sanitizeHtml from "#methods/utils/sanitize.js";
import { getServerSettings } from "#methods/settings/schemaHelpers.js";
import resolveAttachments from "#methods/files/resolveAttachment.js";

// Reply (and React) records have empty `to` by design — visibility inherits
// from the parent — so the generic federation helper returns no targets. For
// these we route based on the parent's domain (held in `target`).
function getChildFederationTargets(childObj) {
  const parentId = childObj?.target;
  if (!parentId) return { shouldFederate: false };
  const parsedParent = kowloonId(parentId);
  const { domain: serverDomain } = getServerSettings();
  if (!parsedParent.domain || parsedParent.domain.toLowerCase() === serverDomain?.toLowerCase()) {
    return { shouldFederate: false };
  }
  return { shouldFederate: true, scope: "domain", domains: [parsedParent.domain] };
}

function stripHtmlFromMarkdown(text) {
  if (typeof text !== "string") return text;
  // Match the Create handler: keep <u>/<s> (underline/strikethrough have no
  // Markdown equivalent); everything else is stripped. Full XSS sanitization
  // still runs in safeMarkdown() at render time via ALLOWED_TAGS.
  const stripped = sanitizeHtml(text, {
    allowedTags: ["u", "s"],
    allowedAttributes: {},
  });
  return stripped
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

const MODELS = {
  Bookmark,
  Circle,
  Group,
  Page,
  Post,
  React: ReactModel,
  Reply,
  User,
};

// Fields each objectType allows to be patched.
// Anything not in the set is silently stripped before the $set.
const ALLOWED_FIELDS = {
  User:     new Set(["profile", "prefs", "to", "canReply", "canReact", "email", "username"]),
  Post:     new Set(["title", "summary", "source", "body", "type", "tags", "to", "canReply", "canReact", "image", "attachments", "href", "target", "location", "event"]),
  Reply:    new Set(["source", "body", "tags"]),
  Page:     new Set(["title", "summary", "source", "body", "slug", "tags", "to", "canReply", "canReact", "image", "attachments", "href", "parentId", "order"]),
  Bookmark: new Set(["title", "summary", "source", "body", "type", "tags", "to", "canReply", "canReact", "href", "target", "parentFolder", "image"]),
  Circle:   new Set(["name", "summary", "icon", "to", "canReply", "canReact"]),
  Group:    new Set(["name", "summary", "icon", "image", "to", "canReply", "canReact", "rsvpPolicy", "location"]),
  React:    new Set(["emoji", "name"]),
};

// Object types that should be synced to FeedItems.
// Bookmarks are excluded — they're personal utility, not feed content.
const FEED_CACHEABLE_TYPES = ["Post", "Reply", "Page", "Group", "Circle"];

/**
 * Strip disallowed fields from patch; return only the allowed subset.
 */
function filterPatch(objectType, patch) {
  const allowed = ALLOWED_FIELDS[objectType];
  if (!allowed) return { ...patch }; // unknown type: pass through (handled by validate)
  return Object.fromEntries(
    Object.entries(patch).filter(([k]) => allowed.has(k))
  );
}

/**
 * Update FeedItems when source object is updated
 */
async function updateFeedItems(updated, objectType, patchFields) {
  try {
    if (!FEED_CACHEABLE_TYPES.includes(objectType)) return;

    const sanitizedObject = { ...updated };
    delete sanitizedObject.to;
    delete sanitizedObject.canReply;
    delete sanitizedObject.canReact;
    delete sanitizedObject.deletedAt;
    delete sanitizedObject.deletedBy;
    delete sanitizedObject.source;
    delete sanitizedObject._id;
    delete sanitizedObject.__v;

    const cacheUpdate = {
      updatedAt: new Date(),
      object: sanitizedObject,
    };

    // Shared by the to/canReply/canReact coarsening below — all three use
    // the same to-shaped vocabulary and the same tier mapping.
    const { domain } = getServerSettings();
    const dom = String(domain || "").toLowerCase();

    if (patchFields.type !== undefined) cacheUpdate.type = updated.type;

    if (patchFields.to !== undefined) {
      // Map the raw `to` to the coarse FeedItems tier, matching the create-time
      // mapping in enqueueFanOut.js#parseAudience. The domain form (@<domain>) is
      // the server tier — missing it here mislabeled edited-to-community posts as
      // "audience", which the community feed excludes, so they vanished (#46).
      const val = String(updated.to || "").toLowerCase().trim();
      cacheUpdate.to =
        val === "@public" || val === "public" ? "public"
        : val === "@server" || val === "server" || (dom && val === `@${dom}`) ? "server"
        : "audience";
    }
    // canReply/canReact use the same to-shaped vocabulary as `to` — coarsen
    // them the identical way (mirrors the `to` block above). Previously
    // defaulted any unrecognized value (i.e. any real circle:/group:-scoped
    // restriction) to "public" instead of "audience" — silently granting
    // public reply/react access to anything meant to be restricted. This
    // coarse cache is a display hint only; actual enforcement reads the raw
    // value (methods/feed/visibility.js authorizeInteraction).
    if (patchFields.canReply !== undefined) {
      const val = String(updated.canReply || "").toLowerCase().trim();
      cacheUpdate.canReply =
        val === "@public" || val === "public" ? "public"
        : val === "@server" || val === "server" || (dom && val === `@${dom}`) ? "server"
        : "audience";
    }
    if (patchFields.canReact !== undefined) {
      const val = String(updated.canReact || "").toLowerCase().trim();
      cacheUpdate.canReact =
        val === "@public" || val === "public" ? "public"
        : val === "@server" || val === "server" || (dom && val === `@${dom}`) ? "server"
        : "audience";
    }

    await FeedItems.findOneAndUpdate({ id: updated.id }, { $set: cacheUpdate });
  } catch (err) {
    console.error(`FeedItems update failed for ${updated.id}:`, err.message);
  }
}

/**
 * Type-specific validation for Update activities
 */
export function validate(activity) {
  const errors = [];

  if (!activity?.object || typeof activity.object !== "object") {
    errors.push("Update: missing required field 'object' (patch data)");
  }

  if (!activity?.target || typeof activity.target !== "string") {
    errors.push("Update: missing required field 'target' (object ID)");
  }

  if (activity?.objectType) {
    const Model = MODELS[activity.objectType];
    if (!Model) {
      errors.push(`Update: unsupported objectType "${activity.objectType}"`);
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}

export async function getFederationTargets(activity, updated) {
  return getFederationTargetsHelper(activity, updated);
}

export default async function Update(activity) {
  try {
    // 1. Validate shape
    const validation = validate(activity);
    if (!validation.valid) {
      return { activity, error: validation.errors.join("; ") };
    }

    // 2. Resolve model from target ID
    const parsed = kowloonId(activity.target);
    const Model = MODELS[parsed?.type];
    if (!Model) {
      return { activity, error: `Update: unsupported target type "${parsed?.type}"` };
    }

    const query =
      parsed.type === "URL" ? { url: activity.target } : { id: activity.target };

    const current =
      (await Model.findOne(query).lean?.()) ?? (await Model.findOne(query));
    if (!current) {
      return { activity, error: `Update: target not found: ${activity.target}` };
    }

    // 3. Authorization
    // For User objects, the "owner" is the user themselves (current.id).
    // For everything else, the "owner" is the actorId field.
    const ownerActorId =
      parsed.type === "User" ? current.id : current.actorId;

    const isOwner = activity.actorId === ownerActorId;
    const isAdmin = await isServerAdmin(activity.actorId);

    if (!isOwner && !isAdmin) {
      return { activity, error: "Update: not authorized to modify this object" };
    }

    // Normalize the patch to mirror Create, so edits accept the same payload
    // the composer sends: featuredImage → image (schema field), and attachment
    // objects → bare file-ID strings ([String] schema). featuredImage/attachments
    // aren't in most allowlists, so this must run before filterPatch.
    if (activity.object && typeof activity.object === "object") {
      if (
        activity.object.featuredImage !== undefined &&
        activity.object.image === undefined
      ) {
        activity.object.image = activity.object.featuredImage;
      }
      delete activity.object.featuredImage;
      if (Array.isArray(activity.object.attachments)) {
        if (parsed.type === "Post") {
          // Post stores the fully-resolved Attachment subdocument shape.
          activity.object.attachments = await resolveAttachments(activity.object.attachments);
        } else {
          // Page still stores bare File-ID strings — not touched here, see issue #52.
          activity.object.attachments = activity.object.attachments
            .map((a) => (typeof a === "string" ? a : a?.fileId))
            .filter(Boolean);
        }
      }
      // Location → GeoPoint, mirroring Create. Mobile sends bare { name, lat, lon }
      // (no type:"Place"); without this it fails GeoPoint validation on edit (#55).
      const loc = activity.object.location;
      if (typeof loc === "string") {
        activity.object.location = { name: loc, type: "Point", coordinates: [0, 0] };
      } else if (loc && typeof loc.lat === "number" && typeof loc.lon === "number") {
        activity.object.location = {
          name: loc.name || "",
          type: "Point",
          coordinates: [loc.lon, loc.lat],
        };
      }

      // Normalize addressing in the patch to the canonical scheme (only fields
      // actually being changed are present). canReply/canReact inherit the
      // patched (or unchanged) `to` when blank isn't meaningful — but in a patch
      // we only touch what's provided, so pass each through canonicalTo directly.
      if (activity.object.to !== undefined) {
        activity.object.to = canonicalTo(activity.object.to);
      }
      if (activity.object.canReply !== undefined) {
        activity.object.canReply = canonicalTo(activity.object.canReply, {
          default: activity.object.to ?? "@public",
        });
      }
      if (activity.object.canReact !== undefined) {
        activity.object.canReact = canonicalTo(activity.object.canReact, {
          default: activity.object.to ?? "@public",
        });
      }
    }

    // 4. Strip disallowed fields from the patch
    const patch = filterPatch(parsed.type, activity.object);

    if (parsed.type === "Circle") {
      // System circles (Following, All Following, Groups, Blocked, Muted) are
      // load-bearing pointers on the User doc — name/summary/icon are fixed
      // identity, not user-editable. Membership (via Add/Remove) and
      // visibility stay fully editable.
      if (current.type === "System") {
        delete patch.name;
        delete patch.summary;
        delete patch.icon;
      }
      // canReply/canReact aren't independently meaningful for a Circle today
      // (kept on the schema for a possible future circle-comments feature) —
      // they always mirror `to`. If this patch isn't touching `to`, drop any
      // canReply/canReact the client sent rather than let them diverge.
      if ("to" in patch) {
        patch.canReply = patch.to;
        patch.canReact = patch.to;
      } else {
        delete patch.canReply;
        delete patch.canReact;
      }
    }

    if (parsed.type === "Post" && "target" in patch) {
      // Keep targetActor in sync whenever target changes — same server-side-
      // only resolution as Create (issue #44). targetActor itself is already
      // stripped by filterPatch (not in ALLOWED_FIELDS.Post), so there's
      // nothing to trust/distrust from the client here, just recompute.
      // null (not undefined) so a cleared target actually unsets it via
      // $set — undefined keys get silently dropped before reaching Mongo.
      if (patch.target) {
        try {
          const targetItem = await FeedItems.findOne({ id: patch.target }).select("object").lean();
          patch.targetActor = targetItem?.object?.actor ?? null;
        } catch {
          patch.targetActor = null;
        }
      } else {
        patch.targetActor = null;
      }
    }

    // For nested object patches like User.profile, expand to dot-notation so
    // a partial patch (e.g. `{ profile: { name: 'New' } }`) doesn't replace
    // the entire embedded document and wipe sibling fields like icon/urls.
    if (parsed.type === 'User' && patch.profile && typeof patch.profile === 'object') {
      for (const [k, v] of Object.entries(patch.profile)) {
        patch[`profile.${k}`] = v;
      }
      delete patch.profile;
    }
    if (patch.prefs && typeof patch.prefs === 'object') {
      for (const [k, v] of Object.entries(patch.prefs)) {
        patch[`prefs.${k}`] = v;
      }
      delete patch.prefs;
    }

    // User profile audience: cap to @public or the user's own server domain.
    // Accept a couple of friendly shorthands ("public", "server") from clients.
    if (parsed.type === "User" && "to" in patch) {
      const ownDomain = current.domain || (typeof current.id === "string" ? current.id.split("@").pop() : null);
      const raw = String(patch.to ?? "").trim().toLowerCase();
      if (raw === "" || raw === "@public" || raw === "public") {
        patch.to = "@public";
      } else if (raw === "server" || (raw.startsWith("@") && ownDomain && raw === `@${ownDomain.toLowerCase()}`)) {
        patch.to = ownDomain ? `@${ownDomain}` : "@public";
      } else {
        return { activity, error: "Update: User.to must be '@public' or '@<own-domain>'" };
      }
    }

    // Folder moves (Bookmark or Folder rec with new parentFolder) need the
    // depth/cycle check that pre-save would enforce on .save(). Update goes
    // through findOneAndUpdate, which skips that hook.
    if (parsed.type === "Bookmark" && "parentFolder" in patch) {
      const targetType = patch.type || current.type;
      if (targetType === "Folder") {
        const { assertFolderDepthOk } = await import("#methods/bookmarks/visibility.js");
        try {
          await assertFolderDepthOk(patch.parentFolder || undefined, current.id);
        } catch (err) {
          return { activity, error: `Update: ${err.message}` };
        }
      }
    }

    // Enforce markdown-only for content fields: strip raw HTML from source.content
    // regardless of what the client sent, so edits can't inject HTML either.
    if (patch.source?.content) {
      patch.source = {
        ...patch.source,
        mediaType: "text/markdown",
        content: stripHtmlFromMarkdown(patch.source.content),
      };
    }

    // 5. Password change — handled separately; cannot be done by admins on behalf of users
    if (parsed.type === "User" && "password" in activity.object) {
      const pwChange = activity.object.password;

      if (!isOwner) {
        return { activity, error: "Update: only the account owner can change their password" };
      }
      if (!pwChange?.current || !pwChange?.new) {
        return { activity, error: "Update: password change requires { current, new }" };
      }
      if (typeof pwChange.new !== "string" || pwChange.new.length < 8) {
        return { activity, error: "Update: new password must be at least 8 characters" };
      }

      const valid = await bcrypt.compare(pwChange.current, current.password);
      if (!valid) {
        return { activity, error: "Update: current password is incorrect" };
      }

      const hashed = await bcrypt.hash(pwChange.new, 12);
      await User.updateOne({ id: current.id }, { $set: { password: hashed } });
    }

    // Remove password from the regular $set patch regardless
    delete patch.password;

    // A creator-supplied Circle icon must never be overwritten by the auto
    // mosaic generator — clear the generated flag so regeneration skips it.
    if (parsed.type === "Circle" && Object.prototype.hasOwnProperty.call(patch, "icon")) {
      patch.iconGenerated = false;
    }

    // If nothing left to patch (e.g. only password was sent), return early
    if (Object.keys(patch).length === 0 && !("password" in activity.object)) {
      return { activity, error: "Update: no updatable fields provided" };
    }

    // 6. Apply patch (skip if nothing left after password-only update)
    let updated = current;
    if (Object.keys(patch).length > 0) {
      // Content-bearing types whose editable source changed must go through
      // .save() so the model's pre-save hook re-renders `body` (and summary /
      // textPreview / signature) from the new source. findOneAndUpdate — used
      // for every other case — skips that hook, which left the rendered body
      // stale after a content edit (the feed/detail render `body`, not source).
      const CONTENT_TYPES = new Set(["Post", "Reply", "Page"]);
      const sourceChanged =
        CONTENT_TYPES.has(parsed.type) &&
        patch.source &&
        typeof patch.source === "object" &&
        patch.source.content !== undefined;

      if (sourceChanged) {
        // Never touches attachments (only re-renders body/summary/signature
        // from source) — excluded to stay safe while attachments may still
        // hold legacy string data under the new subdocument schema.
        const doc = await Model.findOne(query).select("-attachments");
        if (!doc) {
          return { activity, error: `Update: failed to update ${activity.target}` };
        }
        for (const [k, v] of Object.entries(patch)) doc.set(k, v);
        // Clear derived counts so the hook recomputes them (it keeps existing
        // truthy values otherwise).
        doc.wordCount = undefined;
        doc.charCount = undefined;
        await doc.save();
        updated = doc.toObject();
      } else {
        updated =
          (await Model.findOneAndUpdate(query, { $set: patch }, { new: true, runValidators: true }).lean?.()) ??
          (await Model.findOneAndUpdate(query, { $set: patch }, { new: true, runValidators: true }));
      }

      if (!updated) {
        return { activity, error: `Update: failed to update ${activity.target}` };
      }
    }

    activity.objectId = updated.id ?? activity.target;
    activity.object = patch; // normalise to the filtered patch for downstream

    // 7. Sync FeedItems cache
    await updateFeedItems(updated, parsed.type, patch);

    // 8. For local User profile updates, propagate name/icon to all denormalized actor copies
    if (parsed.type === 'User' && ('profile.name' in patch || 'profile.icon' in patch)) {
      refreshActorCache(updated.id, {
        ...('profile.name' in patch ? { name: updated.profile?.name } : {}),
        ...('profile.icon' in patch ? { icon: updated.profile?.icon } : {}),
      }).catch(() => {}); // fire and forget
    }

    // 9. Federation — bookmarks are personal-only, never federated. Replies
    // and Reacts have empty `to` (visibility inherits from parent), so the
    // generic helper would return no targets — route via the parent's domain.
    const federation = parsed.type === "Bookmark"
      ? { shouldFederate: false }
      : parsed.type === "Reply" || parsed.type === "React"
      ? getChildFederationTargets(updated)
      : await getFederationTargets(activity, updated);

    // 10. Sanitize result — strip sensitive fields from User objects
    let resultObj = updated.toObject ? updated.toObject() : { ...updated };
    if (parsed.type === "User") {
      delete resultObj.password;
      delete resultObj.privateKey;
      delete resultObj.publicKeyJwk;
      delete resultObj.signature;
    }

    return { activity, created: resultObj, result: resultObj, federation };
  } catch (err) {
    return { activity, error: err?.message || String(err) };
  }
}
