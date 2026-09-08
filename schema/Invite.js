// Server Invite schema for Kowloon
// Allows admins to create invitation codes for new user registration
// Two types: "individual" (single email) and "open" (anyone with code)

import mongoose from "mongoose";
import { randomBytes } from "crypto";
import QRCode from "qrcode";
import { getServerSettings } from "#methods/settings/schemaHelpers.js";

const Schema = mongoose.Schema;

const RedemptionSchema = new Schema(
  {
    userId: { type: String, required: true },
    email: { type: String },
    redeemedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const InviteSchema = new Schema(
  {
    // Standard Kowloon ID (invite:uuid@domain)
    id: { type: String, unique: true, index: true },

    // Who created the invite (must be admin/mod)
    actorId: { type: String, required: true, index: true },
    server: { type: String },

    // Invite type: "individual" (single use, specific email) or "open" (multi-use)
    type: {
      type: String,
      required: true,
      enum: ["individual", "open"],
      default: "individual",
      index: true,
    },

    // For individual invites: the specific email that can redeem this
    email: {
      type: String,
      lowercase: true,
      trim: true,
      index: true,
      sparse: true, // Allows null for open invites
    },

    // The invite code/token (URL-safe)
    code: { type: String, unique: true, index: true },

    // Generated assets
    url: { type: String },
    qrCode: { type: String }, // base64 data URL

    // For individual invites: single redemption tracking
    usedAt: { type: Date },
    usedBy: { type: String }, // User ID who redeemed

    // For open invites: multiple redemption tracking
    maxRedemptions: { type: Number, default: null }, // null = unlimited
    redemptionCount: { type: Number, default: 0 },
    redemptions: [RedemptionSchema],

    // Status & lifecycle
    active: { type: Boolean, default: true, index: true },
    expiresAt: { type: Date, index: true },

    // Optional personalization
    note: { type: String, maxlength: 500 }, // Admin note ("For the marketing team")
    welcomeMessage: { type: String, maxlength: 1000 }, // Shown on signup page

    // Soft delete
    deletedAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Virtual: is this invite still valid?
InviteSchema.virtual("isValid").get(function () {
  // Must be active and not deleted
  if (!this.active || this.deletedAt) return false;

  // Check expiration
  if (this.expiresAt && new Date() > this.expiresAt) return false;

  // For individual invites: check if already used
  if (this.type === "individual" && this.usedAt) return false;

  // For open invites: check redemption limit
  if (
    this.type === "open" &&
    this.maxRedemptions !== null &&
    this.redemptionCount >= this.maxRedemptions
  ) {
    return false;
  }

  return true;
});

// Virtual: remaining redemptions for open invites
InviteSchema.virtual("remainingRedemptions").get(function () {
  if (this.type !== "open") return null;
  if (this.maxRedemptions === null) return Infinity;
  return Math.max(0, this.maxRedemptions - this.redemptionCount);
});

// Pre-save: generate code, URL, QR code, and validate
InviteSchema.pre("save", async function (next) {
  try {
    const { domain, actorId: serverActorId } = getServerSettings();

    // Generate ID if not set
    if (!this.id) {
      const mongoId = this._id.toString();
      this.id = `invite:${mongoId}@${domain}`;
    }

    // Generate code if not set (16 chars, URL-safe)
    if (!this.code) {
      this.code = randomBytes(12).toString("base64url").slice(0, 16);
    }

    // Generate URL if not set
    if (!this.url) {
      this.url = `https://${domain}/invite/${this.code}`;
    }

    // Set server if not set
    if (!this.server) {
      this.server = serverActorId || `@${domain}`;
    }

    // Validate: individual invites require email
    if (this.type === "individual" && !this.email) {
      throw new Error("Individual invites require an email address");
    }

    // Generate QR code (only on create or if URL changed)
    if (this.isNew || this.isModified("url")) {
      this.qrCode = await QRCode.toDataURL(this.url, {
        width: 256,
        margin: 2,
        errorCorrectionLevel: "M",
      });
    }

    next();
  } catch (err) {
    next(err);
  }
});

// Instance method: check if a specific email can redeem this invite
InviteSchema.methods.canRedeem = function (email) {
  if (!this.isValid) return { allowed: false, reason: "Invite is no longer valid" };

  if (this.type === "individual") {
    if (!email) return { allowed: false, reason: "Email required for this invite" };
    if (email.toLowerCase() !== this.email.toLowerCase()) {
      return { allowed: false, reason: "This invite is for a different email address" };
    }
  }

  return { allowed: true };
};

// Instance method: redeem the invite
InviteSchema.methods.redeem = async function (userId, email) {
  const check = this.canRedeem(email);
  if (!check.allowed) {
    throw new Error(check.reason);
  }

  if (this.type === "individual") {
    this.usedAt = new Date();
    this.usedBy = userId;
  } else {
    // Open invite
    this.redemptions.push({
      userId,
      email: email || undefined,
      redeemedAt: new Date(),
    });
    this.redemptionCount = this.redemptions.length;
  }

  await this.save();
  return this;
};

// Static method: create individual invite
InviteSchema.statics.createIndividual = async function (actorId, email, options = {}) {
  return this.create({
    actorId,
    type: "individual",
    email,
    expiresAt: options.expiresAt,
    note: options.note,
    welcomeMessage: options.welcomeMessage,
  });
};

// Static method: create open invite
InviteSchema.statics.createOpen = async function (actorId, options = {}) {
  return this.create({
    actorId,
    type: "open",
    maxRedemptions: options.maxRedemptions || null,
    expiresAt: options.expiresAt,
    note: options.note,
    welcomeMessage: options.welcomeMessage,
  });
};

// Indexes
InviteSchema.index({ actorId: 1, createdAt: -1 });
InviteSchema.index({ type: 1, active: 1 });
InviteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, partialFilterExpression: { expiresAt: { $exists: true } } });

const Invite = mongoose.model("Invite", InviteSchema);

export default Invite;
