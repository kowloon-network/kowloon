import mongoose from "mongoose";
import { marked } from "marked";
import sanitizeHtml from "#methods/utils/sanitize.js";
import crypto from "crypto";
import { Settings, User, Reply, React } from "./index.js";
import { getServerSettings } from "#methods/settings/schemaHelpers.js";
import { signAs, verifyAs } from "#methods/utils/signing.js";
import AttachmentSchema from "./subschema/Attachment.js";

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
const Schema = mongoose.Schema;
const ObjectId = mongoose.Types.ObjectId;

const slugify = function (str) {
  str = str.replace(/^\s+|\s+$/g, ""); // trim
  str = str.toLowerCase();

  // remove accents, swap ñ for n, etc
  var from = "àáäâèéëêìíïîòóöôùúüûñç·/_,:;";
  var to = "aaaaeeeeiiiioooouuuunc------";
  for (var i = 0, l = from.length; i < l; i++) {
    str = str.replace(new RegExp(from.charAt(i), "g"), to.charAt(i));
  }

  str = str
    .replace(/[^a-z0-9 -]/g, "") // remove invalid chars
    .replace(/\s+/g, "-") // collapse whitespace and replace by -
    .replace(/-+/g, "-"); // collapse dashes

  return str;
};

const PageSchema = new Schema(
  {
    id: { type: String, key: true },
    // Local domain on create; the source domain when hydrated from a remote
    // server (a cached shadow of a remote page). Matches Post/Circle/Group/etc.
    originDomain: { type: String, default: () => getServerSettings()?.domain },
    objectType: { type: String, default: "Page" },
    type: { type: String, default: "Page", enum: ["Page", "Folder"] }, // The type of page this is
    parentId: { type: String, default: null }, // Kowloon ID of parent Page or Folder (null = top-level)
    order: { type: Number, default: 0 },
    url: { type: String }, // The URL of the page
    href: { type: String, default: undefined }, // If the page is a link, this is what it links to
    actorId: { type: String }, // The ID of the page's author
    actor: { type: Object, default: undefined },
    server: { type: String, default: undefined }, // The server of the page's author
    title: { type: String, required: true }, // An optional title for page types other than Notes
    slug: { type: String, default: undefined },
    summary: { type: String, default: undefined }, // An optional summary for page types other than Notes
    source: {
      content: { type: String, default: "" },
      mediaType: { type: String, default: "text/markdown" },
      contentEncoding: { type: String, default: "utf-8" },
    },
    body: { type: String, default: "" },
    wordCount: { type: Number, default: 0 },
    charCount: { type: Number, default: 0 },
    replyCount: { type: Number, default: 0 }, // The number of replies to this page
    reactCount: { type: Number, default: 0 }, // The number of likes to this page
    reactPreview: { type: String, default: null }, // Most-used emoji react
    shareCount: { type: Number, default: 0 }, // The number of shares of this page
    image: { type: String, default: undefined }, // The page's featured/preview image (File ID or URL for backwards compatibility)
    attachments: { type: [AttachmentSchema], default: [] }, // Resolved File references, see schema/subschema/Attachment.js
    tags: { type: [String], default: [] },
    to: { type: String, default: "" },
    canReply: { type: String, default: "" },
    canReact: { type: String, default: "" },
    deletedAt: { type: Date, default: null }, // If this page was deleted, this is when it was deleted. If it's not set the page is not deleted
    deletedBy: { type: String, default: null }, // I`f the activity is deleted, who deleted it (usually the user unless an admin does it)
    signature: Buffer, // The creator's public signature for verification
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

PageSchema.index({
  title: "text",
  source: "text",
  "source.content": "text",
  "location.name": "text",
});

PageSchema.index({ type: 1, "attachments.kind": 1 });

PageSchema.virtual("reacts", {
  ref: "React",
  localField: "id",
  foreignField: "target",
});

PageSchema.virtual("replies", {
  ref: "Reply",
  localField: "id",
  foreignField: "target",
});

PageSchema.pre("save", async function (next) {
  try {
    this.slug = this.slug || slugify(this.title);

    const { domain, actorId } = getServerSettings();
    this.title = this.title && this.title.trim();
    this.id = this.id || `page:${this._id}@${domain}`;
    this.url = this.url || `https://${domain}/pages/${this.slug}`;
    this.server = this.server || actorId;
    this.source.mediaType = "text/markdown";
    this.body = safeMarkdown(this.source.content);
    this.wordCount =
      this.wordCount ||
      this.body
        .replace(/<[^>]*>/g, "")
        .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "")
        .split(" ").length;
    this.charCount = this.charCount || this.body.replace(/<[^>]*>/g, "").length;
    // this.summary =
    //   this.summary ||
    //   `<p>${this.body
    //     .match(/(?<=<p.*?>)(.*?)(?=<\/p>)/g)
    //     .slice(0, 3)
    //     .join("</p>")
    //     .trim()}${
    //     this.body.match(/(?<=<p.*?>)(.*?)(?=<\/p>)/g).length > 3 ? " ..." : ""
    //   }</p>`;

    const sig = await signAs(this.actorId, `${this.id}|${this.createdAt}`);
    if (sig) this.signature = sig;

    this.reactCount = await React.find({ target: this.id }).countDocuments();
    this.replyCount = await Reply.find({ target: this.id }).countDocuments();

    next();
  } catch (e) {
    console.log(e);
  }
});

PageSchema.pre("updateOne", async function (next) {
  const update = this.getUpdate();
  if (update?.$set?.source?.content !== undefined) {
    const currentDoc = await this.model.findOne(this.getQuery()).lean();
    const newSource = { ...(currentDoc?.source || {}), ...update.$set.source };

    update.$set.body = safeMarkdown(newSource.content);
    update.$set.wordCount = update.$set.body.replace(/<[^>]*>/g, "").replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "").split(" ").length;
    update.$set.charCount = update.$set.body.replace(/<[^>]*>/g, "").length;
  }

  if (update?.$set?.title && !update.$set.slug) {
    update.$set.slug = slugify(update.$set.title);
  }

  next();
});

PageSchema.methods.verifySignature = async function () {
  return verifyAs(this.actorId, `${this.id}|${this.createdAt}`, this.signature);
};

export default mongoose.model("Page", PageSchema);
