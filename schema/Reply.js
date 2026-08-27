import mongoose from "mongoose";
import { marked } from "marked";
import sanitizeHtml from "#methods/utils/sanitize.js";
import crypto from "crypto";
import { Settings, User, React } from "./index.js";
import { getServerSettings } from "#methods/settings/schemaHelpers.js";
import { linkifyMentions } from "#methods/mentions/linkify.js";
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

const ReplySchema = new Schema(
  {
    id: { type: String, key: true },
    actorId: { type: String },
    actor: { type: Object, default: undefined },
    server: { type: String, default: undefined }, // The server of the actor
    target: { type: String, required: true },
    to: { type: String, default: "" },
    canReply: { type: String, default: "" },
    canReact: { type: String, default: "" },

    parent: { type: String, default: null },
    href: { type: String },
    source: {
      content: { type: String, default: "" },
      mediaType: { type: String, default: "text/markdown" },
    },
    body: { type: String, default: "" },
    image: { type: String, default: undefined },
    // Net new field (issue #52) — attachments were never declared on this
    // schema before, so ActivityParser/handlers/Reply/index.js's
    // `replyData.attachments = activity.object.attachments` was silently
    // dropped by Mongoose's default strict mode. Nothing to migrate: no
    // Reply document has ever actually persisted attachment data.
    attachments: { type: [AttachmentSchema], default: [] },

    reactCount: { type: Number, default: 0 }, // The number of likes to this post
    reactPreview: { type: String, default: null }, // Most-used emoji react
    replyCount: { type: Number, default: 0 }, // Second-level replies to this reply (threading is capped at 2 levels)
    shareCount: { type: Number, default: 0 }, // The number of shares of this post
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null },
    url: { type: String, default: undefined },
    signature: Buffer,
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
    collection: "replies",
  }
);

ReplySchema.pre("save", async function (next) {
  const { domain, actorId } = getServerSettings();
  this.id = this.id || `reply:${this._id}@${domain}`;
  this.url = this.url || `https://${domain}/posts/${this.id}`;
  this.server = this.server || actorId;
  this.source.mediaType = "text/markdown";
  this.body = safeMarkdown(linkifyMentions(this.source.content));

  if (!this.parent) this.parent = this.target;
  // let stringject = Buffer.from(this.id);
  // const sign = crypto.createSign("RSA-SHA256");
  // sign.update(stringject);
  // this.signature = sign.sign(actor.privateKey, "base64");
  this.reactCount = await React.find({ target: this.id }).countDocuments();
  next();
});

// Keep body in sync when source.content is patched via findOneAndUpdate
// (the pre-save hook above only fires on .save()).
ReplySchema.pre("findOneAndUpdate", async function (next) {
  const update = this.getUpdate();
  if (update?.$set?.source?.content) {
    const current = await this.model.findOne(this.getQuery()).lean();
    const newSource = {
      ...(current?.source || {}),
      ...update.$set.source,
    };
    update.$set.body = safeMarkdown(linkifyMentions(newSource.content));
  }
  next();
});

ReplySchema.methods.verifySignature = async function () {
  let actor = await User.findOne({ id: this.actorId }); // Retrieve the activity actor
  let stringject = Buffer.from(JSON.stringify(this.id));
  return crypto.verify(
    "RSA-SHA256",
    stringject,
    actor.publicKey,
    this.signature
  );
};

export default mongoose.model("Reply", ReplySchema);
