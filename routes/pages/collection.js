// routes/pages/collection.js
// GET /pages — List published pages

import makeCollection from "../utils/makeCollection.js";
import { Page } from "#schema";
import { enrichAttachments } from "#methods/files/enrichAttachments.js";

export default makeCollection({
  model: Page,
  buildQuery: (_req, { query }) => {
    const filter = {
      deletedAt: null,
      to: "@public",
    };
    if (query.tag) filter.tags = query.tag;
    if (query.serverId) filter.server = query.serverId;
    return filter;
  },
  select:
    "id type title slug summary url image attachments tags to parentId order createdAt updatedAt",
  sort: { order: 1, createdAt: -1 },
  sanitize: async (doc, { protocol } = {}) => {
    await enrichAttachments([doc], { protocol });
    return doc;
  },
});
