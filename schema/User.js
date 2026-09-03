import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { signData, verifyData } from "#methods/utils/signing.js";
const Schema = mongoose.Schema;
const ObjectId = mongoose.Types.ObjectId;
import GeoPointSchema from "./subschema/GeoPoint.js";
import ProfileSchema from "./subschema/Profile.js";
import { Settings, Circle, Group } from "./index.js";
import {
  getServerSettings,
  getSetting,
} from "#methods/settings/schemaHelpers.js";

const UserSchemaDef = {
  // Existing fields
  id: { type: String, unique: true }, // e.g., @alice@kwln.org (your current format--kept for compatibility)
  // Local domain on create; the source domain when hydrated from a remote server.
  originDomain: { type: String, default: () => getServerSettings()?.domain },
  server: { type: String },
  objectType: { type: String, default: "User" },
  type: { type: String, default: "Person" },

  // AS/AP alias: preferredUsername <-> username
  // NOT globally unique -- see the compound index below. Two real users on
  // two different servers can legitimately share a bare username (e.g.
  // "jzellis" registered on both kwln.social and kwln.city); only id/actorId
  // (which embed the domain) are actually globally unique.
  username: {
    type: String,
    required: true,
    alias: "preferredUsername",
  },

  password: { type: String },
  email: { type: String, unique: true, sparse: true },
  passwordResetToken: { type: String, select: false },
  passwordResetExpires: { type: Date, select: false },
  emailVerified: { type: Boolean, default: false },
  emailVerificationToken: { type: String, select: false },
  emailVerificationExpires: { type: Date, select: false },
  profile: { type: ProfileSchema, default: {} },

  // Preferences (unchanged)
  prefs: {
    defaultPostType: { type: String, default: "Note" },
    defaultTo: { type: String, default: "@public" },
    defaultcanReply: { type: String, default: "@public" },
    defaultcanReact: { type: String, default: "@public" },
    defaultPostView: {
      type: [String],
      default: ["Note", "Article", "Media", "Link"],
    },
    defaultCircleView: { type: String, default: "" },
    // Feed-selector pins — ordered lists of Kowloon IDs (circle:…@domain /
    // group:…@domain, NOT Mongo _ids) the user pinned to the top of the Circles
    // and Groups sections. First = topmost. Following is seeded into
    // pinnedCircles at registration (and backfilled for existing users) so it
    // pins by default; the user can unpin it like any other. Per-viewer prefs,
    // not federated.
    pinnedCircles: { type: [String], default: [] },
    pinnedGroups: { type: [String], default: [] },
    // Default feed view for the mobile timeline picker:
    // "public" | "server" | a circle ID. Empty = no preference (client falls
    // back to its own default).
    defaultFeedView: { type: String, default: "" },
    // Which screen the mobile app opens to on launch. Values are tab route
    // slugs (discover | feed | search | circles | groups | notifications) plus
    // "admin" for server admins. String so new screens can be added later.
    defaultHomeScreen: { type: String, default: "discover" },
    lang: { type: String, default: "en" },
    // No default on purpose: unset means "inherit the server's default theme"
    // (the admin's site branding, or Auto if the admin hasn't set one) —
    // "system" is a real, distinct explicit choice a user can make (the
    // Auto option), not the same as "hasn't picked anything yet". A schema
    // default here would make every never-touched account indistinguishable
    // from one that deliberately chose Auto, permanently hiding the site
    // theme from them. Existing accounts already stamped with the old
    // "system" default are left as-is — no way to tell whether that was a
    // real choice, so it's not worth guessing.
    theme: { type: String },
    notifications: {
      reply: { type: Boolean, default: true },
      react: { type: Boolean, default: true },
      follow: { type: Boolean, default: true },
      new_post: { type: Boolean, default: true }, // On by default; throttled 12h + read-gated so it stays non-noisy
      mention: { type: Boolean, default: true }, // Someone tagged you (@handle) in a post/reply
      join_request: { type: Boolean, default: true },
      join_approved: { type: Boolean, default: true },
      toasts: { type: Boolean, default: true },
    },
    // Reading typography — set from the mobile app, synced per-account so the
    // reading experience follows the user across devices. Stepped string
    // values; the mobile client owns the px/multiplier mapping.
    typography: {
      fontFamily: { type: String, default: "inter" },
      fontSize: { type: String, default: "m" },
      lineSpacing: { type: String, default: "normal" },
      columnWidth: { type: String, default: "normal" },
    },
  },

  // ActivityPub endpoints (+ aliases)
  inbox: { type: String, alias: "inboxUrl" },
  outbox: { type: String, alias: "outboxUrl" },

  // User's system circles (nested for cleaner organization)
  circles: {
    following: { type: String, default: "" },
    allFollowing: { type: String, default: "" },
    groups: { type: String, default: "" },
    blocked: { type: String, default: "" },
    muted: { type: String, default: "" },
  },

  lastLogin: { type: Date },

  // Keys
  publicKey: { type: String, alias: "publicKeyPem" }, // PEM (your current)
  privateKey: { type: String, alias: "privateKeyPem" }, // PEM (your current)
  publicKeyJwk: { type: Schema.Types.Mixed }, // NEW: structured JWK for interop
  keyRotationAt: { type: Date }, // NEW: track rotations

  // Addressing defaults (unchanged)
  to: { type: String, default: "@public" },
  canReply: { type: String, default: "" },
  canReact: { type: String, default: "" },

  postCount: { type: Number, default: 0 },
  replyCount: { type: Number, default: 0 },
  reactCount: { type: Number, default: 0 },

  // Actor/web metadata
  url: { type: String }, // your existing profile URL
  active: { type: Boolean, default: true },
  deletedAt: { type: Date },
  feedRefreshedAt: { type: Date },

  // NEW: federation helpers
  domain: { type: String }, // e.g., kwln.org
  jwksUrl: { type: String }, // e.g., https://kwln.org/.well-known/jwks.json
  actorId: { type: String, unique: true, sparse: true }, // canonical AS `id` (URL), optional for migration

  // Audit record of which community rules this user acknowledged at
  // registration. Snapshot of the rule text is stored so the record survives
  // later edits to the rules setting.
  acknowledgedRules: [
    {
      _id: false,
      id: { type: String, required: true },
      text: { type: String, required: true },
      acknowledgedAt: { type: Date, default: Date.now },
    },
  ],
};

// Meta
const MetaSchema = new mongoose.Schema(
  {
    seed: { type: String },
    runId: { type: String, index: true },
    externalId: { type: String },
  },
  { _id: false },
);
UserSchemaDef.meta = { type: MetaSchema };

const UserSchema = new mongoose.Schema(UserSchemaDef, {
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
  timestamps: true,
});

/** ---------- Uniqueness ---------- */
// Scoped by originDomain, not global -- see the comment on the username
// field above. Replaces the old global-unique index on username alone.
UserSchema.index({ username: 1, originDomain: 1 }, { unique: true });

/** ---------- Text & dev indexes ---------- */
UserSchema.index({
  username: "text",
  email: "text",
  "profile.name": "text",
  "profile.description": "text",
  "profile.location.name": "text",
});
if (process.env.NODE_ENV === "development") {
  UserSchema.index({ "meta.seed": 1 });
  UserSchema.index({ "meta.externalId": 1 }, { unique: true, sparse: true });
}

// ---------- Virtuals: Circles ----------
UserSchema.virtual("ownedCircles", {
  ref: "Circle",
  localField: "id", // user.id like "@alice@kwln.org"
  foreignField: "actorId", // circles the user owns (Following, Blocked, etc.)
  justOne: false,
});

UserSchema.virtual("memberCircles", {
  ref: "Circle",
  localField: "id",
  foreignField: "members.id", // circles where user is in members[]
  justOne: false,
});

/** ---------- ActivityStreams-friendly virtuals ---------- */
// name <-> profile.name
UserSchema.virtual("name")
  .get(function () {
    return this.profile?.name;
  })
  .set(function (v) {
    this.profile = this.profile || {};
    this.profile.name = v;
  });

// summary <-> profile.description
UserSchema.virtual("summary")
  .get(function () {
    return this.profile?.description;
  })
  .set(function (v) {
    this.profile = this.profile || {};
    this.profile.description = v;
  });

// icon <-> profile.icon
UserSchema.virtual("icon")
  .get(function () {
    return this.profile?.icon;
  })
  .set(function (v) {
    this.profile = this.profile || {};
    this.profile.icon = v;
  });

/** ---------- Hooks ---------- */
UserSchema.pre("save", async function (next) {
  const { domain, actorId } = getServerSettings();
  if (!domain) return next(new Error("Missing Settings: domain"));
  if (this.isModified("password"))
    this.password = bcrypt.hashSync(this.password, 10);

  if (this.isNew) {
    // Keep your existing id scheme for compatibility
    this.id = this.id || `@${this.username}@${domain}`;

    // NEW: set canonical actorId (URL) for AS/AP without breaking your current id
    this.actorId = this.actorId || `https://${domain}/users/${this.username}`;

    // Profile defaults
    this.profile = this.profile || {};
    this.profile.icon =
      this.profile.icon || `https://${domain}/images/user.svg`;

    // Keep your existing url behavior
    this.url = this.url || `https://${domain}/users/${this.id}`;

    // Server / JWKS
    this.server = this.server || actorId;
    this.domain = this.domain || domain;
    this.jwksUrl = this.jwksUrl || `https://${domain}/.well-known/jwks.json`;

    // Keys (PEM for now). Optionally also populate publicKeyJwk if you like.
    if (!this.publicKey || !this.privateKey) {
      const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      this.publicKey = publicKey;
      this.privateKey = privateKey;
      this.keyRotationAt = new Date();
    }

    // Endpoints
    if (!this.inbox)
      this.inbox = `https://${domain}/users/${this.username}/inbox`;
    if (!this.outbox)
      this.outbox = `https://${domain}/users/${this.username}/outbox`;

    // System circles start empty EXCEPT Following: the user is added to their
    // own Following circle so it reads like a home feed (their posts + whoever
    // they later add). This is the only automatic circle membership.
    // Initialize circles subobject
    this.circles = this.circles || {};

    const followingCircle = await Circle.create({
      type: "Circle",
      name: "Following",
      actorId: this.id,
      description: "Following",
      to: this.id,
      canReply: this.id,
      canReact: this.id,
      members: [
        {
          id: this.id,
          name: this.profile?.name || this.username || this.id,
          inbox: this.inbox,
          outbox: this.outbox,
          icon: this.profile?.icon || "",
          url: `https://${domain}/users/${this.username}`,
          server: `@${domain}`,
        },
      ],
      memberCount: 1,
    });
    this.circles.following = followingCircle.id;
    // Pin Following to the top of the feed selector's Circles section by default.
    if (!this.prefs) this.prefs = {};
    if (!Array.isArray(this.prefs.pinnedCircles) || this.prefs.pinnedCircles.length === 0) {
      this.prefs.pinnedCircles = [followingCircle.id];
    }

    const groupsCircle = await Circle.create({
      type: "System",
      name: "Groups",
      actorId: this.id,
      description: "Groups",
      to: this.id,
      canReply: this.id,
      canReact: this.id,
    });
    this.circles.groups = groupsCircle.id;

    const allFollowingCircle = await Circle.create({
      type: "System",
      name: "All Following",
      actorId: this.id,
      description: "All Following",
      to: this.id,
      canReply: this.id,
      canReact: this.id,
    });
    this.circles.allFollowing = allFollowingCircle.id;

    const blockedCircle = await Circle.create({
      type: "System",
      name: "Blocked",
      actorId: this.id,
      description: "Blocked",
      to: this.id,
      canReply: this.id,
      canReact: this.id,
    });
    this.circles.blocked = blockedCircle.id;

    const mutedCircle = await Circle.create({
      type: "System",
      name: "Muted",
      actorId: this.id,
      description: "Muted",
      to: this.id,
      canReply: this.id,
      canReact: this.id,
    });
    this.circles.muted = mutedCircle.id;

    if (!this.profile.pronouns) {
      this.profile.pronouns = getSetting("defaultPronouns");
    }
  }

  next();
});

/** ---------- Methods (unchanged) ---------- */
UserSchema.methods.verifyPassword = async function (plaintext) {
  return await bcrypt.compare(plaintext, this.password);
};

UserSchema.methods.getMemberships = async function () {
  const circles = (
    await Circle.find({
      $or: [{ "members.id": this.id }, { actorId: this.id }],
    }).lean()
  ).map((c) => c.id);

  const groups = (
    await Group.find({
      $or: [
        { "members.id": this.id },
        { actorId: this.id },
        { admins: this.id },
      ],
    }).lean()
  ).map((g) => g.id);

  return [...circles, ...groups];
};

UserSchema.methods.getBlocked = async function () {
  return (await Circle.findOne({ id: this.circles?.blocked })).members.map(
    (m) => m.id,
  );
};

UserSchema.methods.getMuted = async function () {
  return (await Circle.findOne({ id: this.circles?.muted })).members.map(
    (m) => m.id,
  );
};

UserSchema.methods.sign = function (data) {
  return signData(this.privateKey, data);
};

UserSchema.methods.verify = function (data, signature) {
  return verifyData(this.publicKey, data, signature);
};

UserSchema.methods.createUserSignature = function (timestamp) {
  const token = this.id + ":" + timestamp.toString();
  const hash = crypto.createHash("sha256").update(token).digest();
  const signature = crypto
    .sign("sha256", hash, this.privateKey)
    .toString("base64");
  return { id: this.id, timestamp, signature };
};

UserSchema.methods.verifyUserSignature = function (timestamp, signature) {
  const token = this.id + ":" + timestamp;
  const hash = crypto.createHash("sha256").update(token).digest();
  const isValid = crypto.verify(
    "sha256",
    hash,
    this.publicKey,
    Buffer.from(signature, "base64"),
  );
  return isValid ? isValid : new Error("User cannot be authenticated");
};

const User = mongoose.model("User", UserSchema);
export default User;
