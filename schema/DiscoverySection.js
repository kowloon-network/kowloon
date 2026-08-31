// schema/DiscoverySection.js
// A named shelf on the Discover screen (e.g. "Posts We Love"). Server-owned
// and server-signed, like a Page. Discovery items reference a section by its id.
//
// Sections are the organizing unit for Discover: the read endpoint returns
// active sections in `order`, each resolved to its visible discovery items.

import mongoose from "mongoose";
import { getServerSettings, getServerActor } from "#methods/settings/schemaHelpers.js";
import { signAs, verifyAs } from "#methods/utils/signing.js";

const { Schema } = mongoose;

function slugify(str) {
  return String(str || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

const DiscoverySectionSchema = new Schema(
  {
    id: { type: String, unique: true, index: true },
    // Local domain on create; the source domain when hydrated from a remote server.
    originDomain: { type: String, default: () => getServerSettings()?.domain },
    objectType: { type: String, default: "DiscoverySection" },

    // Ownership — always the server actor (defaulted at construction so the
    // required check passes before the pre-save hook runs).
    actorId: {
      type: String,
      required: true,
      default: () => getServerSettings()?.actorId,
    },
    actor: { type: Object, default: undefined },
    server: { type: String, default: undefined },

    // Presentation
    name: { type: String, required: true }, // display title, e.g. "Posts We Love"
    slug: { type: String, default: undefined },
    summary: { type: String, default: undefined }, // optional shelf blurb

    // The row's content type — one row per type (Media/Posts/Circles/Groups/
    // Servers). Drives the card layout on the client and the heuristic query.
    contentType: {
      type: String,
      enum: ["media", "posts", "circles", "groups", "servers"],
      index: true,
    },
    // Where the row's items come from: curated picks only, the heuristic query
    // only, or curated-first with heuristic backfilling to targetCount.
    source: {
      type: String,
      enum: ["curated", "heuristic", "hybrid"],
      default: "hybrid",
    },
    targetCount: { type: Number, default: 12 }, // fill goal for heuristic/hybrid

    order: { type: Number, default: 0 }, // shelf ordering on Discover
    active: { type: Boolean, default: true }, // hide without deleting

    // Section-level visibility. Usually @public; a @<domain> section is only
    // shown to authenticated local users.
    to: { type: String, default: "@public" },

    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null },

    url: { type: String, default: undefined },
    signature: { type: Buffer, default: undefined },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

DiscoverySectionSchema.pre("save", async function (next) {
  try {
    const { domain, actorId } = getServerSettings();
    if (this.name) this.name = this.name.trim();
    if (!this.slug && this.name) this.slug = slugify(this.name);
    if (!this.id && domain) this.id = `section:${this._id}@${domain}`;
    if (!this.url && domain && this.id)
      this.url = `https://${domain}/discovery/${this.slug || this.id}`;
    if (!this.actorId && actorId) this.actorId = actorId;
    if (!this.server && actorId) this.server = actorId;
    if (!this.actor) this.actor = getServerActor() || undefined;

    const sig = await signAs(this.actorId, `${this.id}|${this.name}|${this.to}`);
    if (sig) this.signature = sig;

    next();
  } catch (err) {
    next(err);
  }
});

DiscoverySectionSchema.methods.verifySignature = async function () {
  return verifyAs(this.actorId, `${this.id}|${this.name}|${this.to}`, this.signature);
};

export default mongoose.model(
  "DiscoverySection",
  DiscoverySectionSchema
);
