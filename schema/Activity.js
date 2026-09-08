// /schema/Activity.js
import mongoose from "mongoose";
import Settings from "./Settings.js";
import { getServerSettings } from "#methods/settings/schemaHelpers.js";

const { Schema } = mongoose;

const ActivitySchema = new Schema(
  {
    id: { type: String, key: true }, // activity:<_id>@<domain>
    type: { type: String, default: "Create" },

    // Actor + addressing
    actor: { type: Object, default: undefined },
    actorId: { type: String, required: true },
    to: { type: String, default: "" },

    // Object & target (verby payload)
    object: { type: Object, default: undefined },
    objectType: { type: String, default: undefined },
    objectId: { type: String, default: undefined }, // e.g. created/affected object id
    target: { type: String, default: undefined }, // e.g. id of thing acted upon

    // Housekeeping
    summary: { type: String, default: undefined },
    server: { type: String, default: undefined },
    url: { type: String, default: undefined },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null },

    // Federation / undo helpers
    remoteId: { type: String, default: undefined }, // remote activity id (for idempotency/undo mapping)
    remoteRecipients: { type: [String], default: undefined },
    federated: { type: Boolean, default: false },

    undoOf: { type: String, default: undefined }, // id (or remoteId) being undone

    // Minimal audit trail (do NOT store raw sideEffects)
    audit: {
      effects: {
        kinds: { type: [String], default: undefined }, // e.g. ["write","counter","invalidate"]
        reasons: { type: [String], default: undefined }, // e.g. ["CreatePost","ReplyAdded"]
      },
      handledBy: { type: String, default: undefined }, // e.g., handler name: "Create"
      appliedAt: { type: Date, default: undefined },
    },

    // Optional idempotency
    dedupeKey: { type: String, default: undefined },
  },
  {
    strict: false, // allow unknowns from handlers unless we strip them (we strip _federation in creator)
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Virtuals
// Mint id/url/server like before
ActivitySchema.pre("save", async function (next) {
  try {
    const { domain, actorId } = getServerSettings();

    if (domain) {
      this.id = this.id || `activity:${this._id}@${domain}`;
      this.url = this.url || `https://${domain}/activities/${this.id}`;
    }
    if (actorId) {
      this.server = this.server || actorId;
    }

    next();
  } catch (e) {
    next(e);
  }
});

// Helpful indexes
ActivitySchema.index({ undoOf: 1 });
ActivitySchema.index({ remoteId: 1 }, { sparse: true });
ActivitySchema.index({ dedupeKey: 1 }, { sparse: true });
ActivitySchema.index({ actorId: 1, id: 1 });
ActivitySchema.index({ actorId: 1, type: 1 });
ActivitySchema.index({ "audit.appliedAt": 1 }, { sparse: true });

export default mongoose.model("Activity", ActivitySchema);
