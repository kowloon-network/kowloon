// methods/files/patchAttachmentDimensions.js
// Post/Page attachments snapshot a File's width/height at write time
// (schema/subschema/Attachment.js). Async media processing (workers/mediaProcessor.js)
// can determine a video's real dimensions only after the post/page already
// exists — this patches every already-persisted attachment subdocument
// referencing that fileId, across both source-of-truth collections and
// their denormalized FeedItems copy, so the snapshot stops being stale.

import { Post, Page, FeedItems } from "#schema";

export default async function patchAttachmentDimensions(fileId, { width, height }) {
  if (!fileId || width == null || height == null) return;

  const arrayFilters = [{ "elem.fileId": fileId }];

  await Promise.all([
    Post.updateMany(
      { "attachments.fileId": fileId },
      { $set: { "attachments.$[elem].width": width, "attachments.$[elem].height": height } },
      { arrayFilters }
    ),
    Page.updateMany(
      { "attachments.fileId": fileId },
      { $set: { "attachments.$[elem].width": width, "attachments.$[elem].height": height } },
      { arrayFilters }
    ),
    FeedItems.updateMany(
      { "object.attachments.fileId": fileId },
      { $set: { "object.attachments.$[elem].width": width, "object.attachments.$[elem].height": height } },
      { arrayFilters }
    ),
  ]);
}
