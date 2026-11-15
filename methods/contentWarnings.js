// methods/contentWarnings.js
// Content warnings on Posts and Replies.
//
//   contentWarning: { categories: [key], note: "free text", addedBy: actorId }
//   sensitive: true  -> blur photos and video until tapped
//
// Categories are a fixed list so readers can choose, per category, to show,
// warn (tap to show) or hide. The list must match CW_CATEGORIES in
// @kowloon/client (client/src/contentWarnings.js) -- the client owns the
// labels and the per-reader decision; the server only validates and stores.
//
// The warning lives on the original object. FeedItems.object is a copy of
// it, so every feed picks the warning up with no separate tagging.

export const CW_CATEGORY_KEYS = [
  "spoilers",
  "violence",
  "sexual",
  "death",
  "selfharm",
  "abuse",
  "medical",
  "flashing",
  "drugs",
  "eating",
  "bigotry",
  "animals",
  "phobias",
];

const NOTE_MAX = 140;

/**
 * Normalize a client-supplied warning. Returns:
 *   undefined -> field not supplied (leave as is)
 *   null      -> clear the warning
 *   { categories, note } otherwise
 * Unknown categories are dropped; an empty result clears.
 */
export function normalizeContentWarning(input) {
  if (input === undefined) return undefined;
  if (input === null || input === false || input === "") return null;
  let categories = [];
  let note = "";
  if (typeof input === "string") {
    note = input;
  } else if (typeof input === "object") {
    categories = Array.isArray(input.categories) ? input.categories : [];
    note = typeof input.note === "string" ? input.note : "";
  } else {
    return null;
  }
  categories = [...new Set(categories.map((c) => String(c).toLowerCase().trim()))].filter((c) =>
    CW_CATEGORY_KEYS.includes(c)
  );
  note = note.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, NOTE_MAX);
  if (!categories.length && !note) return null;
  return { categories, note };
}

// Apply normalization to an object being created or patched, in place.
// `addedBy` is set only when someone other than the author sets it.
export function applyContentWarningFields(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if ("contentWarning" in obj) {
    const cw = normalizeContentWarning(obj.contentWarning);
    if (cw === undefined) delete obj.contentWarning;
    else obj.contentWarning = cw;
  }
  if ("sensitive" in obj) obj.sensitive = obj.sensitive === true || obj.sensitive === "true";
  return obj;
}

// Plain-language label for notifications, link previews and push text.
const LABELS = {
  spoilers: "spoilers",
  violence: "violence",
  sexual: "sexual content",
  death: "death or grief",
  selfharm: "self-harm",
  abuse: "abuse",
  medical: "medical",
  flashing: "flashing images",
  drugs: "drugs and alcohol",
  eating: "eating and weight",
  bigotry: "bigotry or slurs",
  animals: "animal harm",
  phobias: "phobias",
};

export function hasContentWarning(obj) {
  const cw = obj?.contentWarning;
  return !!(cw && ((cw.categories && cw.categories.length) || cw.note));
}

export function contentWarningText(obj) {
  const cw = obj?.contentWarning;
  if (!hasContentWarning(obj)) return "";
  const parts = (cw.categories || []).map((c) => LABELS[c] || c);
  if (cw.note) parts.push(cw.note);
  return `Content warning: ${parts.join(", ")}`;
}
