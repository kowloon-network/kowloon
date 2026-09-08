// schema/Bookmark.js
import mongoose from "mongoose";
import Settings from "./Settings.js";
import { marked } from "marked";
import sanitizeHtml from "#methods/utils/sanitize.js";
import { getServerSettings } from "#methods/settings/schemaHelpers.js";
import { signAs } from "#methods/utils/signing.js";

const ALLOWED_TAGS = [
  "p", "br", "strong", "em", "s", "u", "a", "ul", "ol", "li",
  "blockquote", "code", "pre", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "img",
];
const ALLOWED_ATTRIBUTES = {
  a: ["href", "title", "rel", "target"],
  img: ["src", "alt", "title"],
  code: ["class"],
  pre: ["class"],
};

function safeMarkdown(content) {
  const raw = marked(content ?? "");
  return sanitizeHtml(raw, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: ["http", "https", "mailto"],
    disallowedTagsMode: "discard",
  });
}

const { Schema } = mongoose;

const BookmarkSchema = new Schema(
  {
    // Stable Kowloon ID: "bookmark:<uuid>@<domain>"
    id: { type: String, unique: true, index: true },
    // Local domain on create; the source domain when hydrated from a remote server.
    originDomain: { type: String, default: () => getServerSettings()?.domain },
    objectType: { type: String, default: "Bookmark" },

    // Bookmark or Folder (collection)
    type: {
      type: String,
      enum: ["Bookmark", "Folder"],
      default: "Bookmark",
      index: true,
    },

    // 🔐 Ownership (NEW)
    actorId: { type: String, required: true },

    // Folder hierarchy
    parentFolder: { type: String, default: undefined, index: true }, // id of a Folder

    // What is being bookmarked
    // Either an internal target id (post:/event:/page:/etc) OR an external URL (href).
    target: { type: String, default: undefined, index: true },
    href: { type: String, default: undefined },

    // Presentation
    title: { type: String, default: undefined },
    image: { type: String, default: undefined },

    // Visibility of the *bookmark record itself*
    to: { type: String, default: "" },

    // Optional metadata
    tags: { type: [String], default: [] },
    summary: { type: String, default: undefined },
    source: {
      content: { type: String, default: "" },
      mediaType: { type: String, default: "text/markdown" },
    },
    body: { type: String, default: "" },

    // Lifecycle
    deletedAt: { type: Date, default: null, index: true },
    deletedBy: { type: String, default: null },

    // Convenience
    url: { type: String, default: undefined },
    replyCount: { type: Number, default: 0 }, // The number of replies to this bookmark
    reactCount: { type: Number, default: 0 }, // The number of likes to this bookmark
    reactPreview: { type: String, default: null }, // Most-used emoji react
    shareCount: { type: Number, default: 0 }, // The number of shares of this bookmark

    // 🧯 Back-compat (deprecated): map to ownerId/ownerType if present
    actorId: { type: String, default: undefined }, // DEPRECATED
    actor: { type: Object, default: undefined }, // DEPRECATED
    server: { type: String, default: undefined }, // host/domain (kept if you use it elsewhere)

    signature: { type: Buffer, default: undefined },
  },
  {
    strict: false,
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// ---- Indexes for common access patterns ----
BookmarkSchema.index({ ownerId: 1, createdAt: -1 }); // listing someone's bookmarks
BookmarkSchema.index({ parentFolder: 1, createdAt: -1 }); // folder views
BookmarkSchema.index({ to: 1, ownerType: 1 });
BookmarkSchema.index({ target: 1, createdAt: -1 }); // reverse lookups / cleanup

// Full-text index for local search. Bookmarks never federate (they're a personal
// utility), so this only ever serves the owner's own tree, scoped by
// buildVisibilityQuery. See memory: bookmarks-are-personal-only.
BookmarkSchema.index({
  title: "text",
  summary: "text",
  "source.content": "text",
  body: "text",
  tags: "text",
});

// If you want reactions *to bookmarks* (optional; keep if you use it)
// ------ Helpers ------
function inferOwnerTypeFromId(id) {
  if (!id || typeof id !== "string") return "user";
  if (id.startsWith("@server@")) return "server";
  if (id.startsWith("group:")) return "group";
  return id.startsWith("@") ? "user" : "user";
}

// ------ Pre-save normalization ------
BookmarkSchema.pre("save", async function (next) {
  try {
    if (this.isNew) {
      // Load domain + default server actor
      const { domain, actorId } = getServerSettings();
      if (!domain) throw new Error("Bookmark: missing Settings.domain");

      // id + url
      if (!this.id) {
        // Note: using this._id gives a stable ObjectId; embed domain as spec
        this.id = `bookmark:${this._id}@${domain}`;
      }
      if (!this.url) {
        this.url = `https://${domain}/bookmarks/${encodeURIComponent(this.id)}`;
      }

      // ownerId / ownerType (NEW) -- back-compat with legacy actorId
      if (!this.ownerId && this.actorId) {
        this.ownerId = this.actorId;
      }
      if (!this.ownerType && this.ownerId) {
        this.ownerType = inferOwnerTypeFromId(this.ownerId);
      }

      // Ensure required ownership is set
      if (!this.ownerId || !this.ownerType) {
        throw new Error("Bookmark requires ownerId and ownerType");
      }

      // Visibility default
      this.to = this.to || "@public";

      // Image + presentation defaults
      this.image = this.image || `https://${domain}/images/bookmark.png`;
      if (!this.title) this.title = this.href || this.target || this.title;

      // Render body from source
      const content = this.source?.content || "";
      if (this.source) this.source.mediaType = "text/markdown";
      this.body = safeMarkdown(content);

      // Optional: store server label (domain) if you use it for queries
      if (!this.server) this.server = domain;
    } else {
      // On updates, keep ownerId/ownerType consistent if someone edits actorId
      if (!this.ownerId && this.actorId) this.ownerId = this.actorId;
      if (this.ownerId && !this.ownerType)
        this.ownerType = inferOwnerTypeFromId(this.ownerId);
    }

    // Validation: either target (internal object) OR href (external) must exist for type=Bookmark
    if (this.type === "Bookmark") {
      if (!this.target && !this.href) {
        throw new Error("Bookmark requires either target or href");
      }
    }

    // Folder depth cap (also catches cycles). Only relevant for Folders;
    // Bookmarks are allowed inside the deepest folder.
    if (this.type === "Folder" && (this.isModified("parentFolder") || this.isNew)) {
      const { assertFolderDepthOk } = await import("#methods/bookmarks/visibility.js");
      await assertFolderDepthOk(this.parentFolder, this.id);
    }

    const sig = await signAs(this.actorId, `${this.id}|${this.href || this.target || ""}|${this.source?.content || ""}`);
    if (sig) this.signature = sig;

    next();
  } catch (err) {
    next(err);
  }
});

export default mongoose.model("Bookmark", BookmarkSchema);
