// /methods/users/deleteAccountCascade.js
//
// Self-service account deletion (Apple App Store Guideline 5.1.1(v)): unlike
// the generic Delete{User} path, which only flips `active:false` with no
// cascade (see ActivityParser/handlers/Delete/index.js), this actually
// removes the account and the content tied to it.
//
// Deliberately LOCAL-ONLY -- no federation push for this. A departing user's
// historical public posts that other servers already pulled stay there,
// same as deleting your Gmail account doesn't recall mail you already sent.
//
// The caller (routes/auth/delete-account.js) is expected to have ALREADY
// flipped the target User to `active:false` before calling this, so
// revocation (routes/utils/route.js) takes effect immediately even if this
// cascade is still running or fails partway through. Every step here is
// safe to re-run (bulk ops on already-tombstoned/already-gone rows are
// no-ops), so a partial failure can simply be retried.
import {
  Bookmark,
  Circle,
  FeedItems,
  File,
  Flag,
  Group,
  Notification,
  Page,
  Post,
  PushToken,
  React as ReactModel,
  Reply,
  Settings,
  User,
} from "#schema";
import { syncTargetReactState } from "#ActivityParser/handlers/React/index.js";
import { getStorageAdapter } from "#methods/files/index.js";

const TOMBSTONE = (actorId) => ({
  deletedAt: new Date(),
  deletedBy: actorId,
  type: "Tombstone",
});

// Small concurrent batches, not one-at-a-time -- a prolific user's file purge
// is the one real risk of exceeding the request timeout (confirmed generous
// at 120s, but serial per-file S3 round-trips could still exceed it).
async function purgeFilesInBatches(files, batchSize = 8) {
  const storage = await getStorageAdapter();
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    await Promise.all(
      batch.map((f) =>
        storage.delete(f.storageKey).catch((err) => {
          console.error(`File purge failed for ${f.id}:`, err.message);
        })
      )
    );
  }
}

// The server's earliest-registered admin (adminCircle member), excluding the
// account being deleted. Used to reassign ownership of any Group the
// deleting user owns -- never left orphaned.
async function resolveNewGroupOwner(excludingActorId) {
  const setting = await Settings.findOne({ name: "adminCircle" }).lean();
  const adminCircle = setting?.value
    ? await Circle.findOne({ id: setting.value }).select("members").lean()
    : null;
  const candidateIds = (adminCircle?.members || [])
    .map((m) => m.id)
    .filter((id) => id && id !== excludingActorId);
  if (!candidateIds.length) return null;

  const admins = await User.find({ id: { $in: candidateIds } })
    .select("id username profile url inbox outbox server")
    .sort({ createdAt: 1 })
    .limit(1)
    .lean();
  return admins[0] || null;
}

function memberSnapshot(user) {
  return {
    id: user.id,
    name: user?.profile?.name,
    icon: user?.profile?.icon,
    url: user?.url,
    inbox: user?.inbox,
    outbox: user?.outbox,
    server: user?.server,
  };
}

export default async function deleteAccountCascade(actorId) {
  const ownedGroups = await Group.find({ actorId }).select("id circles").lean();

  // Sole-admin-with-a-group guard: block rather than invent server-owned-Group
  // semantics we haven't verified are safe elsewhere in the codebase.
  let newOwner = null;
  if (ownedGroups.length) {
    newOwner = await resolveNewGroupOwner(actorId);
    if (!newOwner) {
      return {
        ok: false,
        error:
          "You're the only server admin and own at least one Group. Promote another admin before deleting your account.",
      };
    }
  }

  // Reassign owned Groups to the new owner, seeding them into Admins/
  // Moderators/Members the same dedupe-guarded way Group.js's own pre-save
  // hook seeds a brand-new creator.
  const ownerMember = newOwner ? memberSnapshot(newOwner) : null;
  for (const group of ownedGroups) {
    await Group.updateOne(
      { id: group.id },
      { $set: { actorId: newOwner.id, actor: ownerMember } }
    );
    const now = new Date();
    await Promise.all(
      [group.circles?.admins, group.circles?.moderators, group.circles?.members]
        .filter(Boolean)
        .map((circleId) =>
          Circle.findOneAndUpdate(
            { id: circleId, "members.id": { $ne: ownerMember.id } },
            { $push: { members: ownerMember }, $set: { updatedAt: now } }
          )
        )
    );
  }

  // Pull the deleting user out of every circle they're a member of
  // (everyone else's personal circles, every Group circle) -- same shape as
  // the Remove/Leave handlers.
  await Circle.updateMany(
    { "members.id": actorId },
    { $pull: { members: { id: actorId } }, $inc: { memberCount: -1 } }
  );

  // Bulk-tombstone content. Bookmark is matched on EITHER `ownerId` or
  // `actorId` -- the schema has a shadowed/deprecated second `actorId` key
  // and a pre-save normalization meant to backfill `ownerId` from it, but
  // live testing on kwln.dev found a real bookmark with `actorId` set and
  // `ownerId` genuinely absent (the two-phase create -- actorId attached on
  // a second save, after the pre-save hook's isNew backfill already ran --
  // likely never re-runs the backfill). Matching both fields is the safe
  // fix; this is a pre-existing bug independent of this cascade.
  const tombstone = TOMBSTONE(actorId);
  await Promise.all([
    Post.updateMany({ actorId }, { $set: tombstone }),
    Reply.updateMany({ actorId }, { $set: tombstone }),
    Page.updateMany({ actorId }, { $set: tombstone }),
    Bookmark.updateMany(
      { $or: [{ ownerId: actorId }, { actorId }] },
      { $set: tombstone }
    ),
  ]);

  // Reactions: hard-delete (no structural reason to keep a tombstoned
  // React), then recompute reactCount/reactPreview/reactSummary on every
  // target they'd reacted to so other users' counts stay correct.
  const reactTargets = await ReactModel.find({ actorId }).distinct("target");
  await ReactModel.deleteMany({ actorId });
  for (const targetId of reactTargets) {
    await syncTargetReactState(targetId);
  }

  await PushToken.deleteMany({ userId: actorId });

  // The user's own circles (System + user-created) -- safe to remove
  // entirely now that the owning User is going away.
  await Circle.deleteMany({ actorId });

  await Notification.deleteMany({ $or: [{ recipientId: actorId }, { actorId }] });
  await FeedItems.deleteMany({ actorId });

  const files = await File.find({ actorId }).select("id storageKey").lean();
  await purgeFilesInBatches(files);
  await File.deleteMany({ actorId });

  // Flags they filed -- not meaningful once they're gone. Flags filed
  // AGAINST them are left as a historical moderation record, on purpose.
  await Flag.deleteMany({ actorId });

  await User.deleteOne({ id: actorId });

  return { ok: true, reassignedGroups: ownedGroups.length, newOwnerId: newOwner?.id };
}
