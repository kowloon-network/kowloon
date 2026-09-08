/**
 * Kowloon ID helpers
 * Users:           @username@domain
 * Other objects:   objecttype:uuid@domain
 */

/** Return the canonical type for a Kowloon ID ("User", "Post", "Group", ...). */
export function getTypeFromId(id) {
  if (typeof id !== "string" || !id.includes("@")) {
    throw new Error(`Invalid Kowloon ID: ${id}`);
  }
  if (id.startsWith("@")) return "User"; // user IDs have no "type:" prefix
  const typePart = id.split(":")[0]; // e.g., "post" from "post:uuid@domain"
  if (!typePart) throw new Error(`Invalid Kowloon object ID: ${id}`);
  return typePart.charAt(0).toUpperCase() + typePart.slice(1);
}

/** Convenience: true if the id is a user id ("@username@domain"). */
export function isUserId(id) {
  return (
    typeof id === "string" && id.startsWith("@") && id.indexOf("@", 1) !== -1
  );
}

/**
 * Ensures a Kowloon ID matches the expected object type.
 * @param {string} id        - Kowloon ID to check.
 * @param {string} expected  - Expected type (capitalized, e.g. "User", "Post").
 */
export default function assertTypeFromId(id, expected) {
  const actual = getTypeFromId(id);
  if (actual !== expected) {
    throw new Error(`Expected ${expected} ID but got ${actual}: ${id}`);
  }
}
