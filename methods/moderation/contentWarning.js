// methods/moderation/contentWarning.js
// A moderator adds, changes or removes the content warning on someone
// else's post or reply -- a gentler step than removing it. The warning is
// marked addedBy so the author can't edit it away (Update handler).
//
// Works for remote posts too: we change our own copy (the Post/Reply row if
// we hold one, and always the FeedItems copy every feed reads from).

import { Post, Reply, FeedItems } from "#schema";
import { normalizeContentWarning, contentWarningText } from "#methods/contentWarnings.js";
import createNotification from "#methods/notifications/create.js";
import { getSetting } from "#methods/settings/cache.js";

const MODELS = { post: Post, reply: Reply };

function modelFor(id) {
  const prefix = String(id || "").split(":")[0].toLowerCase();
  return { Model: MODELS[prefix], objectType: prefix === "reply" ? "Reply" : "Post" };
}

/**
 * @returns {Promise<{found:boolean, objectType?:string, actorId?:string, contentWarning?:object|null, sensitive?:boolean}>}
 */
export async function applyModeratorWarning({ targetId, contentWarning, sensitive, staffId }) {
  const { Model, objectType } = modelFor(targetId);
  if (!Model) return { found: false };

  const [doc, item] = await Promise.all([
    Model.findOne({ id: targetId, deletedAt: null }).select("id actorId contentWarning sensitive").lean(),
    FeedItems.findOne({ id: targetId }).select("id actorId object.contentWarning object.sensitive").lean(),
  ]);
  if (!doc && !item) return { found: false };

  const cw = normalizeContentWarning(contentWarning ?? null);
  const nextCw = cw ? { ...cw, addedBy: staffId } : null;
  const nextSensitive =
    sensitive === undefined ? !!(doc?.sensitive ?? item?.object?.sensitive) : sensitive === true;

  if (doc) {
    await Model.updateOne(
      { id: targetId },
      nextCw
        ? { $set: { contentWarning: nextCw, sensitive: nextSensitive } }
        : { $unset: { contentWarning: 1 }, $set: { sensitive: nextSensitive } }
    );
  }
  if (item) {
    await FeedItems.updateOne(
      { id: targetId },
      nextCw
        ? { $set: { "object.contentWarning": nextCw, "object.sensitive": nextSensitive, updatedAt: new Date() } }
        : { $unset: { "object.contentWarning": 1 }, $set: { "object.sensitive": nextSensitive, updatedAt: new Date() } }
    );
  }

  return {
    found: true,
    objectType,
    actorId: doc?.actorId || item?.actorId,
    contentWarning: nextCw,
    sensitive: nextSensitive,
  };
}

// Tell the author what changed. Only local authors get notifications.
export async function notifyAuthorOfWarning({ result, staffId, targetId, href }) {
  if (!result?.actorId) return;
  const domain = String(getSetting("domain") || "").toLowerCase();
  if (!String(result.actorId).toLowerCase().endsWith(`@${domain}`)) return;
  const what = result.objectType === "Reply" ? "reply" : "post";
  const summary = result.contentWarning
    ? `A moderator added a content warning to your ${what} (${contentWarningText({ contentWarning: result.contentWarning }).replace(/^Content warning: /, "")}).`
    : result.sensitive
      ? `A moderator marked the photos in your ${what} as sensitive.`
      : `A moderator removed the content warning from your ${what}.`;
  await createNotification({
    type: "moderation",
    recipientId: result.actorId,
    actorId: staffId,
    objectId: targetId,
    objectType: result.objectType,
    summary,
    href,
  });
}
