// routes/utils/makeCollection.js
// Reusable factory for paginated collection endpoints with visibility filtering.

import route from "./route.js";
import { activityStreamsCollection } from "./oc.js";
import { getSetting } from "#methods/settings/cache.js";

/**
 * Creates a GET collection route handler.
 *
 * @param {Object} opts
 * @param {import('mongoose').Model} opts.model - Mongoose model to query
 * @param {Function} [opts.buildQuery] - (req, { query, user }) => MongoDB filter object
 * @param {string} [opts.select] - Fields to select (Mongoose .select() string)
 * @param {Object} [opts.sort] - Sort order, default { createdAt: -1 }
 * @param {Function} [opts.sanitize] - (doc) => sanitized object for response
 * @param {Function} [opts.basePath] - (req) => base URL string for pagination links
 * @param {number} [opts.defaultLimit] - Default page size, default 20
 * @param {number} [opts.maxLimit] - Max page size, default 100
 * @param {Object} [opts.routeOpts] - Options passed to route() wrapper (e.g. { allowUnauth: false })
 */
export default function makeCollection({
  model,
  buildQuery = () => ({}),
  select,
  sort = { createdAt: -1 },
  sanitize = (doc) => doc,
  basePath,
  defaultLimit = 20,
  maxLimit = 100,
  routeOpts = {},
} = {}) {
  return route(async ({ req, query, user, set }) => {
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(
      Math.max(1, parseInt(query.limit, 10) || defaultLimit),
      maxLimit
    );
    const skip = (page - 1) * limit;

    const filter = await buildQuery(req, { query, user });

    let q = model.find(filter);
    if (select) q = q.select(select);
    q = q.sort(sort).skip(skip).limit(limit);

    const [docs, total] = await Promise.all([
      q.lean(),
      model.countDocuments(filter),
    ]);

    const domain = getSetting("domain");
    const protocol = req.headers["x-forwarded-proto"] || "https";

    const items = await Promise.all(docs.map((doc) => sanitize(doc, { protocol, req })));

    const base = basePath
      ? basePath(req)
      : `${protocol}://${domain}${req.baseUrl}`;

    const collection = activityStreamsCollection({
      id: page ? `${base}?page=${page}` : base,
      orderedItems: items,
      totalItems: total,
      page,
      itemsPerPage: limit,
      baseUrl: base,
    });

    for (const [key, value] of Object.entries(collection)) {
      set(key, value);
    }
  }, routeOpts);
}
