// /schema/Server.js
import mongoose from "mongoose";

const { Schema } = mongoose;

/**
 * Remote server registry + poll state.
 * Used by the domain-grouped pull scheduler for /outbox/pull.
 */
const CursorSchema = new Schema(
  {
    cursor: { type: String }, // opaque server-supplied bookmark
    etag: { type: String }, // for If-None-Match / 304s
    filtersHash: { type: String }, // hash(JSON.stringify(normalized filters))
    // For traceability/debug:
    actors: { type: [String], default: undefined }, // ONLY for actors-scope entries
    audience: { type: [String], default: undefined }, // ONLY for audience-scope entries
    updatedAt: { type: Date, default: () => new Date() },
    lastUsedAt: { type: Date, default: () => new Date() }, // for cursor GC
  },
  { _id: false }
);

const ServerSchema = new Schema(
  {
    // Identity
    id: { type: String, required: true, unique: true, index: true }, // usually same as domain
    name: { type: String, default: undefined }, // display name (may include capitalization)
    domain: { type: String, required: true, unique: true, index: true }, // normalized: lowercased, punycode, no scheme/port
    aliases: { type: [String], default: undefined }, // alternate hostnames for same peer

    // Cryptographic keys for server-to-server authentication
    publicKey: { type: String, default: undefined }, // RSA public key in PEM format for JWT verification
    pullEndpoint: { type: String, default: undefined }, // Custom pull endpoint URL (defaults to https://{domain}/federation/pull)

    // Audience tracking - reference counts instead of storing user IDs
    // Array of { id, count } — stored as array to avoid Mongoose Map's dot-in-key restriction
    // (actor IDs like @alice@remote.com contain dots which are forbidden in Mongoose Map keys).
    actorsRefCount: {
      type: [{ id: { type: String }, count: { type: Number, default: 0 } }],
      default: undefined,
      _id: false,
    },
    serverFollowersCount: { type: Number, default: 0 }, // count of locals following @server

    // Endpoints (auto-filled)
    inbox: { type: String },
    outbox: { type: String },
    jwks: { type: String }, // JWKS endpoint (if advertised)
    nodeinfo: { type: String }, // optional discovery

    // Capabilities advertised/observed on the peer
    supports: {
      capabilityGrants: { type: Boolean, default: true }, // per-user action tokens
      audienceScope: { type: Boolean, default: true }, // supports audience bucket
      compression: { type: Boolean, default: true }, // accepts gzip/deflate/br
      signedPull: { type: Boolean, default: true }, // requires JWT on /outbox/pull
    },

    // Trust & moderation state
    status: {
      type: String,
      enum: ["unknown", "trusted", "limited", "blocked", "muted"],
      default: "unknown",
      index: true,
    },
    blockReasons: { type: [String], default: undefined },
    muteReasons: { type: [String], default: undefined },
    notes: { type: String, default: undefined },

    // Content filtering (per-server)
    contentFilters: {
      rejectObjectTypes: { type: [String], default: undefined }, // e.g., ["Post", "Bookmark"]
      rejectPostTypes: { type: [String], default: undefined }, // e.g., ["Article", "Video"]
    },

    // Poll configuration
    include: {
      public: { type: Boolean, default: true },
      actors: { type: Boolean, default: true },
      audience: { type: Boolean, default: true },
    },

    // Pull policy & guardrails
    timeouts: {
      connectMs: { type: Number, default: 10000 }, // 10s connection timeout
      readMs: { type: Number, default: 30000 }, // 30s read timeout
    },
    retries: {
      max: { type: Number, default: 3 },
      jitter: { type: Boolean, default: true },
    },
    tls: {
      minVersion: { type: String, default: "TLSv1.2" },
      pin: { type: String, default: undefined }, // optional kid pinning
    },
    acceptEncodings: { type: [String], default: () => ["br", "gzip"] },
    maxPage: { type: Number, default: 100 }, // max items per pull page

    // Per-scope rate limits
    scopeRate: {
      public: {
        rps: { type: Number, default: 5 },
        burst: { type: Number, default: 20 },
      },
      actors: {
        rps: { type: Number, default: 3 },
        burst: { type: Number, default: 10 },
      },
      audience: {
        rps: { type: Number, default: 2 },
        burst: { type: Number, default: 5 },
      },
    },

    // Scheduler state
    scheduler: {
      nextPollAt: { type: Date, index: true },
      backoffMs: { type: Number, default: 0 },
      errorCount: { type: Number, default: 0 },
      lastError: { type: String, default: undefined },
      lastErrorCode: {
        type: String,
        enum: [
          "ECONN",
          "ETIMEOUT",
          "EJWT",
          "EFORMAT",
          "EHTTP",
          "ETLS",
          "EOTHER",
        ],
        default: undefined,
      },
      lastSuccessfulPollAt: { type: Date, default: undefined },
      // Next pull's `since`: newest remote publishedAt received (pollWorker).
      pullCursor: { type: Date, default: undefined },
    },

    // Unified pull tracking (for new /.well-known/kowloon/pull endpoint)
    nextPullAt: { type: Date, index: true }, // When to next pull from this server
    lastPulledAt: { type: Date, default: undefined }, // Last successful pull
    lastPullAttemptedAt: { type: Date, default: undefined }, // Last attempt (success or fail)
    pullErrorCount: { type: Number, default: 0 }, // Consecutive errors
    lastPullError: { type: String, default: undefined }, // Last error message

    // Discovery & validation state
    discovery: {
      lastTriedAt: { type: Date, default: undefined },
      lastOkAt: { type: Date, default: undefined },
      error: { type: String, default: undefined },
    },
    wellKnown: {
      nodeinfo: { type: Schema.Types.Mixed, default: undefined },
      hostmeta: { type: Schema.Types.Mixed, default: undefined },
    },

    // Cursors (per-scope).  For actors/audience we key by a stable set hash.
    cursors: {
      public: CursorSchema,
      actors: { type: Map, of: CursorSchema, default: undefined }, // key: actorsSetHash
      audience: { type: Map, of: CursorSchema, default: undefined }, // key: audienceSetHash
    },
    cursorTtlDays: { type: Number, default: 90 }, // GC stale cursor entries after N days

    // JWKS cache (for verifying their JWTs)
    jwksCache: {
      uri: { type: String, default: undefined },
      keys: { type: Schema.Types.Mixed, default: undefined }, // raw JWKS JSON
      fetchedAt: { type: Date, default: undefined },
      preferredKid: { type: String, default: undefined },
    },

    // Privacy & audit
    logLevel: {
      type: String,
      enum: ["none", "errors", "summary", "verbose"],
      default: "errors",
    },
    privacy: {
      redactUserIdsInLogs: { type: Boolean, default: true },
    },

    // Telemetry
    stats: {
      itemsSeen: { type: Number, default: 0 },
      lastItemAt: { type: Date, default: undefined },
      notModifiedHits: { type: Number, default: 0 }, // 304s
      consecutiveNotModified: { type: Number, default: 0 }, // signal to throttle
    },

    // Health
    lastSeenAt: { type: Date, default: undefined }, // any successful contact
    createdBy: { type: String, default: "system" }, // who added this domain
  },
  {
    strict: false,
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

ServerSchema.pre("save", function (next) {
  // Normalize domain (lowercase, no scheme/port)
  if (this.domain) {
    this.domain = this.domain
      .toLowerCase()
      .replace(/^https?:\/\//, "") // strip scheme
      .replace(/:\d+$/, ""); // strip port
  }

  // Fill common endpoints if missing
  if (this.domain) {
    if (!this.inbox) this.inbox = `https://${this.domain}/inbox`;
    if (!this.outbox) this.outbox = `https://${this.domain}/outbox`;
    if (!this.jwks) this.jwks = `https://${this.domain}/.well-known/jwks.json`;
  }

  // Default id to domain if not set
  if (!this.id && this.domain) {
    this.id = `@${this.domain}`;
  }

  // Auto-update include flags based on reference counts
  const hasActorFollows = Array.isArray(this.actorsRefCount) && this.actorsRefCount.length > 0;
  const hasServerFollows = this.serverFollowersCount > 0;

  this.include = this.include || {};
  this.include.actors = hasActorFollows;
  this.include.audience = hasActorFollows; // audience scope needs actor follows
  this.include.public = hasServerFollows || hasActorFollows; // public if either exists

  // Normalize cursor updatedAt on change
  const now = new Date();
  if (this.cursors?.public && !this.cursors.public.updatedAt)
    this.cursors.public.updatedAt = now;
  next();
});

// Helpful indexes for the poller
ServerSchema.index({ status: 1, "scheduler.nextPollAt": 1 });
ServerSchema.index({ "cursors.public.updatedAt": -1 });

export default mongoose.model("Server", ServerSchema);
