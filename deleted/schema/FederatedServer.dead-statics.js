// Extracted from schema/FederatedServer.js
// Dead-code audit finding: 12 of this model's 15 statics have zero callers
// anywhere in the repo. There is no server/routes/admin/servers.js at all —
// the remote-server moderation UI (block/suspend a whole server, the
// follower/member reference-counting used to decide what to keep pulling)
// this schema was clearly built to support doesn't exist yet. Only
// recordPullSuccess/recordPullError/getServersReadyForPull are live,
// used by workers/federationPull.js — those three stay in the live schema.

FederatedServerSchema.statics.incrementFollowers = async function (domain) {
  if (!domain) return;
  await this.findOneAndUpdate(
    { domain },
    {
      $inc: { localFollowerCount: 1 },
      $setOnInsert: {
        status: "active",
        nextPullAt: new Date(),
        pullIntervalMs: 300000,
        discoveredAt: new Date(),
        discoveredVia: "federation",
      },
    },
    { upsert: true }
  );
};

FederatedServerSchema.statics.decrementFollowers = async function (domain) {
  if (!domain) return;
  const server = await this.findOneAndUpdate(
    { domain },
    { $inc: { localFollowerCount: -1 } },
    { new: true }
  );
  if (server && server.localFollowerCount <= 0 && server.localMemberCount <= 0 && server.localCircleFollowers <= 0) {
    await this.findByIdAndUpdate(server._id, { nextPullAt: null });
  }
};

FederatedServerSchema.statics.incrementMembers = async function (domain) {
  if (!domain) return;
  await this.findOneAndUpdate(
    { domain },
    {
      $inc: { localMemberCount: 1 },
      $setOnInsert: {
        status: "active",
        nextPullAt: new Date(),
        pullIntervalMs: 300000,
        discoveredAt: new Date(),
        discoveredVia: "federation",
      },
    },
    { upsert: true }
  );
};

FederatedServerSchema.statics.decrementMembers = async function (domain) {
  if (!domain) return;
  const server = await this.findOneAndUpdate(
    { domain },
    { $inc: { localMemberCount: -1 } },
    { new: true }
  );
  if (server && server.localFollowerCount <= 0 && server.localMemberCount <= 0 && server.localCircleFollowers <= 0) {
    await this.findByIdAndUpdate(server._id, { nextPullAt: null });
  }
};

// Called when a local user adds @domain (bare server) to a circle.
FederatedServerSchema.statics.incrementCircleFollowers = async function (domain) {
  if (!domain) return;
  await this.findOneAndUpdate(
    { domain },
    {
      $inc: { localCircleFollowers: 1 },
      $setOnInsert: {
        status: "active",
        nextPullAt: new Date(),
        pullIntervalMs: 300000,
        discoveredAt: new Date(),
        discoveredVia: "circle-follow",
      },
    },
    { upsert: true }
  );
};

FederatedServerSchema.statics.decrementCircleFollowers = async function (domain) {
  if (!domain) return;
  const server = await this.findOneAndUpdate(
    { domain },
    { $inc: { localCircleFollowers: -1 } },
    { new: true }
  );
  if (server && server.localFollowerCount <= 0 && server.localMemberCount <= 0 && server.localCircleFollowers <= 0) {
    await this.findByIdAndUpdate(server._id, { nextPullAt: null });
  }
};

FederatedServerSchema.statics.recordPushSuccess = async function (domain) {
  if (!domain) return;
  await this.findOneAndUpdate(
    { domain },
    {
      lastPushAt: new Date(),
      lastPushAttemptedAt: new Date(),
      pushErrorCount: 0,
      lastPushError: null,
    },
    { upsert: true }
  );
};

FederatedServerSchema.statics.recordPushError = async function (domain, error) {
  if (!domain) return;
  await this.findOneAndUpdate(
    { domain },
    {
      $inc: { pushErrorCount: 1 },
      lastPushError: error.substring(0, 500),
      lastPushAttemptedAt: new Date(),
    },
    { upsert: true }
  );
};

// Interaction block — pulls continue, incoming activities are rejected.
FederatedServerSchema.statics.blockServer = async function (domain, reason) {
  await this.findOneAndUpdate(
    { domain },
    {
      status: "blocked",
      blockedAt: new Date(),
      blockedReason: reason,
      // nextPullAt intentionally untouched — local subscribers still get content
    },
    { upsert: true }
  );
};

FederatedServerSchema.statics.unblockServer = async function (domain) {
  await this.findOneAndUpdate(
    { domain },
    {
      status: "active",
      blockedAt: null,
      blockedReason: null,
      pullErrorCount: 0,
      nextPullAt: new Date(),
    }
  );
};

// Full defederation — no pulls, all incoming activities rejected.
FederatedServerSchema.statics.suspendServer = async function (domain, reason) {
  await this.findOneAndUpdate(
    { domain },
    {
      status: "suspended",
      suspendedAt: new Date(),
      suspendedReason: reason,
      nextPullAt: null,
    },
    { upsert: true }
  );
};

FederatedServerSchema.statics.unsuspendServer = async function (domain) {
  await this.findOneAndUpdate(
    { domain },
    {
      status: "active",
      suspendedAt: null,
      suspendedReason: null,
      pullErrorCount: 0,
      nextPullAt: new Date(),
    }
  );
};
