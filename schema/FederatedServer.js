// schema/FederatedServer.js
// Tracks federated servers for efficient batch pulls, health monitoring,
// profile caching, and moderation (block / suspend).
//
// Two moderation levels:
//   "blocked"   — interaction block only (replies/reacts from this server are
//                 rejected, Link posts to it are prohibited). Content pulls
//                 continue so local users who subscribe can still read it.
//   "suspended" — full defederation. All pulls stop, all incoming activities
//                 rejected. Reserved for CSAM, severe harassment, etc.

import mongoose from "mongoose";
const Schema = mongoose.Schema;

// ── Cached content subdocuments ──────────────────────────────────────────────
// Kept intentionally lean — these are preview cards, not full mirrors.

const CachedCircleSchema = new Schema(
  {
    id:          { type: String, required: true },
    name:        { type: String },
    summary:     { type: String },
    icon:        { type: String }, // URL
    url:         { type: String }, // link to view on remote server
    memberCount: { type: Number, default: 0 },
    reactCount:  { type: Number, default: 0 }, // popularity signal
  },
  { _id: false }
);

const CachedGroupSchema = new Schema(
  {
    id:          { type: String, required: true },
    name:        { type: String },
    summary:     { type: String },
    icon:        { type: String },
    image:       { type: String }, // hero/banner
    url:         { type: String },
    memberCount: { type: Number, default: 0 },
    rsvpPolicy:  { type: String }, // open | serverOpen | serverApproval | approvalOnly
  },
  { _id: false }
);

const CachedPageSchema = new Schema(
  {
    title: { type: String, required: true },
    url:   { type: String, required: true },
    icon:  { type: String },
  },
  { _id: false }
);

// ── Main schema ───────────────────────────────────────────────────────────────

const FederatedServerSchema = new Schema(
  {
    // ── Identity ──────────────────────────────────────────────────────────────
    domain:  { type: String, required: true, unique: true, index: true },
    baseUrl: { type: String }, // e.g., https://mastodon.social

    // ── Software (from NodeInfo) ──────────────────────────────────────────────
    software: { type: String }, // "mastodon", "kowloon", "pixelfed", …
    version:  { type: String },

    // ── Server profile (from remote info endpoint) ────────────────────────────
    name:              { type: String },
    icon:              { type: String }, // server avatar/logo URL
    image:             { type: String }, // hero/banner URL
    description:       { type: String }, // plain text, HTML stripped
    language:          { type: [String], default: [] }, // primary language codes
    openRegistrations: { type: Boolean },
    userCount:         { type: Number },
    postCount:         { type: Number },
    location: {
      name:      { type: String },
      latitude:  { type: Number },
      longitude: { type: Number },
    },
    profileFetchedAt: { type: Date }, // when we last refreshed the above

    // ── Cached public content ─────────────────────────────────────────────────
    // Capped at top-20 by popularity — not a full mirror.
    cachedCircles:    { type: [CachedCircleSchema], default: [] },
    circlesFetchedAt: { type: Date },

    cachedGroups:    { type: [CachedGroupSchema], default: [] },
    groupsFetchedAt: { type: Date },

    cachedPages:    { type: [CachedPageSchema], default: [] },
    pagesFetchedAt: { type: Date },

    // ── Discovery metadata ────────────────────────────────────────────────────
    discoveredAt:  { type: Date },
    discoveredVia: {
      type: String,
      enum: ["webfinger", "federation", "manual", "circle-follow"],
    },

    // ── Local interest counters ───────────────────────────────────────────────
    localFollowerCount:   { type: Number, default: 0 }, // local users following remote users here
    localMemberCount:     { type: Number, default: 0 }, // local users in remote groups/events
    localCircleFollowers: { type: Number, default: 0 }, // local users with @domain in a circle
    remoteUserCount:      { type: Number, default: 0 }, // cached remote users from this server

    // ── Pull scheduling ───────────────────────────────────────────────────────
    lastPulledAt:          { type: Date },
    lastPullAttemptedAt:   { type: Date },
    nextPullAt:            { type: Date, index: true },
    pullIntervalMs:        { type: Number, default: 300000 }, // adaptive; 5 min default

    // ── Health tracking ───────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ["active", "slow", "unreachable", "blocked", "suspended"],
      default: "active",
      index: true,
    },
    pullErrorCount:       { type: Number, default: 0 },
    lastPullError:        { type: String },
    lastSuccessfulPullAt: { type: Date },

    // ── Push federation (inbox delivery) ──────────────────────────────────────
    lastPushAt:          { type: Date },
    lastPushAttemptedAt: { type: Date },
    pushErrorCount:      { type: Number, default: 0 },
    lastPushError:       { type: String },

    // ── Performance ───────────────────────────────────────────────────────────
    avgResponseTimeMs: { type: Number },

    // ── Admin controls ────────────────────────────────────────────────────────
    blockedAt:     { type: Date },
    blockedReason: { type: String },
    suspendedAt:   { type: Date },
    suspendedReason: { type: String },
    notes:         { type: String },
  },
  { timestamps: true }
);

// ── Indexes ───────────────────────────────────────────────────────────────────

FederatedServerSchema.index({ status: 1, nextPullAt: 1 }); // batch pull selection
FederatedServerSchema.index({ localFollowerCount: 1 });     // cleanup queries
FederatedServerSchema.index({ discoveredAt: -1 });          // browse newest-known servers
FederatedServerSchema.index({ name: 1 });                   // browse / search by name

// ── Static methods ────────────────────────────────────────────────────────────

FederatedServerSchema.statics.recordPullSuccess = async function (domain, itemCount, responseTimeMs) {
  if (!domain) return;
  const now = new Date();

  let pullIntervalMs = 900000; // 15 min — no new items
  if (itemCount >= 10) pullIntervalMs = 300000;       // 5 min — high activity
  else if (itemCount > 0) pullIntervalMs = 600000;    // 10 min — some activity

  const update = {
    lastPulledAt: now,
    lastSuccessfulPullAt: now,
    lastPullAttemptedAt: now,
    pullErrorCount: 0,
    lastPullError: null,
    pullIntervalMs,
    nextPullAt: new Date(now.getTime() + pullIntervalMs),
    status: "active",
  };

  if (responseTimeMs) {
    const server = await this.findOne({ domain }).select("avgResponseTimeMs").lean();
    update.avgResponseTimeMs = server?.avgResponseTimeMs
      ? Math.round(server.avgResponseTimeMs * 0.7 + responseTimeMs * 0.3)
      : responseTimeMs;
  }

  await this.findOneAndUpdate({ domain }, update, { upsert: true });
};

FederatedServerSchema.statics.recordPullError = async function (domain, error) {
  if (!domain) return;
  const server = await this.findOne({ domain });
  const errorCount = (server?.pullErrorCount || 0) + 1;

  // Exponential backoff: 5 min → 15 min → 30 min → 1 hr → 2 hr (max)
  const backoffMs = Math.min(300000 * Math.pow(2, errorCount - 1), 7200000);

  let status = "active";
  if (errorCount >= 10) status = "unreachable";
  else if (errorCount >= 5) status = "slow";

  // Never auto-downgrade a blocked/suspended server's status
  if (server?.status === "blocked" || server?.status === "suspended") {
    status = server.status;
  }

  await this.findOneAndUpdate(
    { domain },
    {
      $inc: { pullErrorCount: 1 },
      lastPullError: error.substring(0, 500),
      lastPullAttemptedAt: new Date(),
      nextPullAt: new Date(Date.now() + backoffMs),
      status,
    },
    { upsert: true }
  );
};

// Returns servers eligible for content pulls.
// "blocked" servers are included — local users can still subscribe to them.
// "suspended" and "unreachable" servers are excluded.
FederatedServerSchema.statics.getServersReadyForPull = async function (limit = 10) {
  const now = new Date();
  return this.find({
    status: { $in: ["active", "slow", "blocked"] },
    nextPullAt: { $lte: now },
    $or: [
      { localFollowerCount: { $gt: 0 } },
      { localMemberCount: { $gt: 0 } },
      { localCircleFollowers: { $gt: 0 } },
    ],
  })
    .sort({ nextPullAt: 1 })
    .limit(limit)
    .lean();
};

const FederatedServer = mongoose.model("FederatedServer", FederatedServerSchema);
export default FederatedServer;
