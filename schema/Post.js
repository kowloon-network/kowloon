import mongoose from "mongoose";
import { marked } from "marked";
import sanitizeHtml from "#methods/utils/sanitize.js";
import { signData, verifyData, signAs, verifyAs } from "#methods/utils/signing.js";
import { Settings, User, React, Reply, Circle } from "./index.js";
import GeoPoint from "./subschema/GeoPoint.js";
import ActorSchema from "./subschema/Actor.js";
import AttachmentSchema from "./subschema/Attachment.js";
import { getServerSettings } from "#methods/settings/schemaHelpers.js";
import { linkifyMentions } from "#methods/mentions/linkify.js";

// Tags and attributes allowed in rendered post bodies.
// Matches what the TipTap editor can produce; no scripts, iframes, or event handlers.
const ALLOWED_TAGS = [
  "p", "br", "strong", "em", "s", "u", "a", "ul", "ol", "li",
  "blockquote", "code", "pre", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "img",
];
const ALLOWED_ATTRIBUTES = {
  a: ["href", "title", "rel", "target"],
  img: ["src", "alt", "title"],
  code: ["class"],    // for syntax-highlighted fenced code blocks
  pre: ["class"],
};

// Generate a summary for timeline display.
// Algorithm:
//   1. ≤ 2 paragraphs, all < 1000 chars → no truncation needed
//   2. > 2 paragraphs, first 2 both < 1000 chars → show first 2 paragraphs
//   3. Otherwise (long paragraphs, or many short ones with a long one) →
//      truncate by sentence boundary until total ≈ 1000 chars
export function generateSummary(source) {
  const content = source?.content;
  if (!content?.trim()) return undefined;

  const paragraphs = content.split(/\n\n+/).map(p => p.trim()).filter(Boolean);

  // Short post — no summary needed
  if (paragraphs.length <= 2 && paragraphs.every(p => p.length < 1000)) {
    return undefined;
  }

  // More than 2 paragraphs, first 2 are readable length
  if (paragraphs.length > 2) {
    const first2 = paragraphs.slice(0, 2);
    if (first2.every(p => p.length < 1000)) {
      return safeMarkdown(first2.join('\n\n'));
    }
  }

  // Sentence-level truncation to ~1000 chars. Slice the ORIGINAL text at a
  // sentence boundary rather than joining paragraphs with spaces — flattening
  // to one line turns block markers into inline text ("> " / "- "), which marked
  // then escapes and mangles (a multi-paragraph blockquote collapsed into one
  // block with literal ">" between paragraphs).
  const full = paragraphs.join('\n\n');
  const boundary = /[.!?](?=\s|$)/g;
  let cut = 0;
  let m;
  while ((m = boundary.exec(full)) !== null) {
    const end = m.index + 1;
    if (end > 1000) break;
    cut = end;
  }
  if (cut === 0) cut = Math.min(full.length, 1000); // no sentence break in range
  const result = full.slice(0, cut).trim();

  return result ? safeMarkdown(result) : undefined;
}

function safeMarkdown(content) {
  const raw = marked(content ?? "");
  return sanitizeHtml(raw, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: ["http", "https", "mailto"],
    disallowedTagsMode: "discard",
  });
}

// Render markdown/source to plain text, dropping all markup. Inserts a space at
// every tag boundary so block elements (lists, paragraphs) don't get glued
// together when the tags are stripped.
function stripToText(content) {
  if (!content) return "";
  const html = marked(content).replace(/></g, "> <");
  const text = sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} });
  return text.replace(/\s+/g, " ").trim();
}

// Plain-text preview for cards, federation summary, og:description, etc.
// First two sentences OR 200 chars, whichever is shorter; '…' appended when
// truncated. Word-boundary trim when hard-cutting.
export function generateTextPreview(source) {
  const fullText = stripToText(source?.content);
  if (!fullText) return undefined;

  const sentences = fullText.split(/(?<=[.!?])\s+/);
  let preview = sentences.slice(0, 2).join(" ");

  if (preview.length > 200) {
    preview = preview.slice(0, 200);
    const lastSpace = preview.lastIndexOf(" ");
    if (lastSpace > 150) preview = preview.slice(0, lastSpace);
  }

  if (preview.length < fullText.length) {
    preview = preview.replace(/[\s.,;:!?]+$/, "") + "…";
  }

  return preview;
}
const Schema = mongoose.Schema;
const ObjectId = mongoose.Types.ObjectId;

const PostSchema = new Schema(
  {
    id: { type: String, key: true },
    // Local domain on create; the source domain when hydrated from a remote server.
    originDomain: { type: String, default: () => getServerSettings()?.domain },
    objectType: { type: String, default: "Post" },
    type: { type: String, default: "Note" }, // The type of post this is
    url: { type: String }, // The URL of the post
    href: { type: String, default: undefined }, // If the post is a link, this is what it links to
    actorId: { type: String }, // The ID of the post's author
    actor: { type: ActorSchema, default: undefined },
    server: { type: String, default: undefined }, // The server of the post's author
    title: { type: String, default: undefined }, // An optional title for post types other than Notes
    summary: { type: String, default: undefined }, // An optional summary for post types other than Notes
    source: {
      content: { type: String, default: "" }, // The raw content of the post -- plain text, HTML or Markdown
      mediaType: { type: String, default: "text/markdown" },
      contentEncoding: { type: String, default: "utf-8" },
      language: { type: String, default: "en" },
    },
    body: { type: String, default: "" },
    textPreview: { type: String, default: undefined },
    wordCount: { type: Number, default: 0 },
    charCount: { type: Number, default: 0 },
    replyCount: { type: Number, default: 0 }, // The number of replies to this post
    reactCount: { type: Number, default: 0 }, // The number of likes to this post
    reactPreview: { type: String, default: null }, // Most-used emoji react
    reactSummary: { type: String, default: null }, // Distinct emojis joined, sorted by count desc
    shareCount: { type: Number, default: 0 }, // The number of shares of this post
    image: { type: String, default: undefined }, // The post's featured/preview image (File ID or URL for backwards compatibility)
    attachments: { type: [AttachmentSchema], default: [] }, // Resolved File references, see schema/subschema/Attachment.js
    tags: { type: [String], default: [] },
    location: { type: GeoPoint, default: undefined }, // A geotag for the post in the ActivityStreams geolocation format
    event: {
      startDate: { type: Date, default: undefined }, // A start time for Event posts
      endDate: { type: Date, default: undefined }, // An end time for Event posts
      rsvp: { type: String },
    },
    target: { type: String, default: undefined }, // For Links
    // Original author of a shared Kowloon post (target), captured at share
    // time — server-resolved only, never client-suppliable (see Create
    // handler). Deliberately a sibling field, not nested into target, to
    // mirror the actorId/actor pattern used everywhere else in this schema.
    targetActor: { type: ActorSchema, default: undefined },
    to: { type: String, default: "" },
    canReply: { type: String, default: "" },
    canReact: { type: String, default: "" },
    deletedAt: { type: Date, default: null }, // If this post was deleted, this is when it was deleted. If it's not set the post is not deleted
    deletedBy: { type: String, default: null }, // I`f the activity is deleted, who deleted it (usually the user unless an admin does it)
    signature: Buffer, // The creator's public signature for verification
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

PostSchema.index({
  title: "text",
  source: "text",
  "source.content": "text",
  "location.name": "text",
});

PostSchema.index({ type: 1, "attachments.kind": 1 });

PostSchema.virtual("reacts", {
  ref: "React",
  localField: "id",
  foreignField: "target",
});

PostSchema.virtual("replies", {
  ref: "Reply",
  localField: "id",
  foreignField: "target",
});

// Render source content to sanitized HTML.
// Only text/markdown is accepted; anything else is treated as plain text.
// safeMarkdown runs marked() then strips all tags not in the allowlist,
// so raw HTML embedded in the markdown (e.g. <script>) is discarded.
function generateBody(source) {
  if (!source?.content) return "";
  if ((source.mediaType ?? "text/markdown") === "text/markdown") {
    return safeMarkdown(source.content);
  }
  // Plain text: escape HTML entities, convert newlines to paragraph breaks
  const escaped = source.content.replace(/[<>&"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c])
  );
  return `<p>${escaped.replace(/(?:\r\n|\r|\n)/g, "</p><p>")}</p>`;
}

PostSchema.pre("save", async function (next) {
  try {
    const { domain, actorId } = getServerSettings();
    this.title = this.title && this.title.trim();
    this.id = this.id || `post:${this._id}@${domain}`;
    this.url = this.url || `https://${domain}/posts/${this.id}`;
    this.server = this.server || actorId;
    this.source.mediaType = this.source.mediaType || "text/markdown";

    // Generate body from source. Linkify @user@domain mentions into profile
    // links first (markdown only) — the stored source.content stays raw so the
    // post remains cleanly editable.
    const isMarkdown =
      (this.source.mediaType ?? "text/markdown") === "text/markdown";
    this.body = generateBody({
      content: isMarkdown
        ? linkifyMentions(this.source.content)
        : this.source.content,
      mediaType: this.source.mediaType,
    });
    this.wordCount =
      this.wordCount ||
      this.body
        .replace(/<[^>]*>/g, "")
        .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "")
        .split(" ").length;
    this.charCount = this.charCount || this.body.replace(/<[^>]*>/g, "").length;
    this.summary = generateSummary(this.source);
    this.textPreview = generateTextPreview(this.source);

    const sig = await signAs(this.actorId, `${this.id}|${this.source.content}`);
    if (sig) this.signature = sig;

    if (this.type === "Event") {
      if (!this.event.rsvp) {
        let rsvpCircle = await Circle.create({
          title: `${this.title} RSVP`,
          to: this.to,
        });
        this.rsvp = rsvpCircle.id;
      }
    }

    // reactCount and replyCount are managed by the Reply/React ActivityParser handlers
    // via findOneAndUpdate($inc). Do not recalculate here — it would overwrite handler increments.
    next();
  } catch (e) {
    console.log(e);
  }
});

PostSchema.pre("updateOne", async function (next) {
  const update = this.getUpdate();

  if (update?.$set?.source?.content !== undefined) {
    const currentDoc = await this.model.findOne(this.getQuery()).lean();
    const newSource = { ...(currentDoc?.source || {}), ...update.$set.source };

    update.$set.body = generateBody(newSource);
    update.$set.textPreview = generateTextPreview(newSource);
    update.$set.wordCount = update.$set.body.replace(/<[^>]*>/g, "").replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "").split(" ").length;
    update.$set.charCount = update.$set.body.replace(/<[^>]*>/g, "").length;

    const sig = await signAs(currentDoc.actorId, `${currentDoc.id}|${newSource.content}`);
    if (sig) update.$set.signature = sig;
  }

  next();
});

PostSchema.pre("findOneAndUpdate", async function (next) {
  const update = this.getUpdate();

  if (update?.$set?.source?.content) {
    const currentDoc = await this.model.findOne(this.getQuery()).lean();
    const newSource = {
      ...(currentDoc?.source || {}),
      ...update.$set.source,
    };

    update.$set.body = generateBody(newSource);
    update.$set.textPreview = generateTextPreview(newSource);

    const sig = await signAs(currentDoc.actorId, `${currentDoc.id}|${newSource.content}`);
    if (sig) update.$set.signature = sig;
  }

  next();
});

PostSchema.methods.verifySignature = async function () {
  return verifyAs(this.actorId, `${this.id}|${this.source.content}`, this.signature);
};

const Post = mongoose.model("Post", PostSchema);
export { Post, PostSchema };
