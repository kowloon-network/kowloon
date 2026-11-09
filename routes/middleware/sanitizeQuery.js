// routes/middleware/sanitizeQuery.js
//
// SECURITY: NoSQL operator injection guard. Express 4's default `qs` query
// parser turns `?id[$ne]=x` into `{ id: { $ne: "x" } }`, and any route that
// drops a query value straight into a Mongo filter then runs the attacker's
// operator (match-everything, regex DoS, ...).
//
// Why not mongoose.set('sanitizeFilter', true)? Read
// node_modules/mongoose/lib/helpers/query/sanitizeFilter.js: it rewrites
// EVERY filter value that has $-keys into `{ $eq: value }` -- including the
// code-built ones this codebase relies on everywhere ({ deletedAt: { $ne:
// null } }, { createdAt: { $gte: since } }, { id: { $in: [...] } }) -- unless
// each is wrapped in mongoose.trusted(). Enabling it globally would silently
// break hundreds of queries.
//
// Instead, normalize req.query so every value is a string or an array of
// strings (no route reads nested query objects; repeatable params like the
// S2S batch-pull `from` / `to` arrive as arrays of strings and are kept).
// `a[0]=x&a[1]=y` style indexed arrays that qs returns as objects are
// converted to arrays; any other nested object is dropped.

function toStringArray(arr) {
  return arr.filter((v) => typeof v === "string");
}

function isIndexObject(obj) {
  const keys = Object.keys(obj);
  return keys.length > 0 && keys.every((k) => /^\d+$/.test(k));
}

export function sanitizeQueryObject(query) {
  if (!query || typeof query !== "object") return query;
  for (const key of Object.keys(query)) {
    const v = query[key];
    if (key.startsWith("$")) {
      delete query[key];
    } else if (typeof v === "string") {
      continue;
    } else if (Array.isArray(v)) {
      query[key] = toStringArray(v);
    } else if (v && typeof v === "object" && isIndexObject(v)) {
      query[key] = toStringArray(Object.values(v));
    } else {
      delete query[key];
    }
  }
  return query;
}

export default function sanitizeQuery(req, _res, next) {
  try {
    sanitizeQueryObject(req.query);
  } catch {
    // never block a request on the sanitizer itself
  }
  next();
}
