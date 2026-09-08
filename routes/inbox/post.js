// /routes/inbox/post.js
import route from "../utils/route.js";
import Kowloon from "#kowloon";
import Inbox from "#schema/Inbox.js";
import { Group, Circle } from "#schema";
import log from "#methods/utils/logger.js";
import checkBlocked from "#methods/inbox/checkBlocked.js";

import normalizeInboundActivity from "#methods/federation/normalizeInboundActivity.js";
import enqueueOutbox from "#methods/federation/enqueueOutbox.js";
import { getSetting } from "#methods/settings/cache.js";
import isLocalDomain from "#methods/parse/isLocalDomain.js";

async function fanOutGroupPost(activity, activityId) {
  try {
    const to = activity.to;
    if (!to?.startsWith("group:")) return;
    const atIdx = to.lastIndexOf("@");
    if (atIdx === -1) return;
    const groupDomain = to.slice(atIdx + 1);
    if (!isLocalDomain(groupDomain)) return;

    const group = await Group.findOne({ id: to }).lean();
    if (!group?.circles?.members) return;

    const membersCircle = await Circle.findOne({ id: group.circles.members }).lean();
    if (!membersCircle?.members?.length) return;

    const localDomain = getSetting("domain") || process.env.DOMAIN;
    const senderDomain = activity.actorId ? activity.actorId.slice(activity.actorId.lastIndexOf("@") + 1) : null;

    const remoteDomains = new Set();
    for (const member of membersCircle.members) {
      if (!member.id) continue;
      const memberAt = member.id.lastIndexOf("@");
      if (memberAt === -1) continue;
      const domain = member.id.slice(memberAt + 1);
      if (domain !== localDomain && domain !== senderDomain) {
        remoteDomains.add(domain);
      }
    }

    if (remoteDomains.size === 0) return;

    await enqueueOutbox({
      activity,
      activityId,
      actorId: activity.actorId,
      federation: { shouldFederate: true, scope: "domain", domains: [...remoteDomains] },
      reason: "group-fanout",
    });

    log.info("Group fan-out enqueued", { groupId: to, domains: [...remoteDomains] });
  } catch (err) {
    log.warn("Group fan-out failed", { error: err.message });
  }
}

function safeHeaders(h = {}) {
  // Store only a safe/diagnostic subset
  const keep = [
    "date",
    "digest",
    "host",
    "signature",
    "user-agent",
    "content-type",
    "content-length",
    "accept",
    "accept-encoding",
    "x-forwarded-for",
  ];
  const out = {};
  for (const k of keep) {
    const v = h[k] ?? h[k.toLowerCase()];
    if (v !== undefined) out[k.toLowerCase()] = v;
  }
  return out;
}

export default route(
  async (api) => {
    const { req, body, setStatus, set } = api;

    // Normalize activity to extract actorId for verification
    const actorId = body.actorId || body.actor?.id || body.actor;

    // For group fan-out: the group server signs and re-broadcasts activities from another server.
    // The actorId domain won't match the keyId domain in this case, so skip domain check.
    const isGroupFanout = body.to?.startsWith("group:");
    const sigActorId = isGroupFanout ? null : actorId;

    // 1) Verify origin server (HTTP Signature with domain verification)
    const sig = await Kowloon.federation.verifyHttpSignature(req, { actorId: sigActorId });
    if (!sig.ok) {
      setStatus(401);
      set({ error: sig.error || "Invalid HTTP Signature" });
      return;
    }

    // For group fan-out the actor/key domain check is skipped above, but we still must
    // verify the signing server actually owns the group. Only the group's host server
    // should be re-broadcasting on its behalf — this prevents evil.local from fanning
    // out posts into a group hosted on kwln1.local.
    if (isGroupFanout) {
      const groupDomain = body.to.slice(body.to.lastIndexOf("@") + 1);
      let keyDomain = null;
      try { keyDomain = new URL(sig.keyId).hostname; } catch (_) {}
      if (!keyDomain || keyDomain !== groupDomain) {
        setStatus(403);
        set({ error: `Group fan-out rejected: signer (${keyDomain ?? "unknown"}) does not own group on ${groupDomain}` });
        return;
      }
    }

    // 2) Check if actor is blocked before processing
    const isBlocked = await checkBlocked({
      actorId,
      to: body.to,
      target: body.target,
      type: body.type,
    });

    if (isBlocked) {
      log.info("Blocked activity rejected", {
        actorId,
        type: body.type,
        domain: sig.domain,
      });
      setStatus(403);
      set({ error: "Actor is blocked" });
      return;
    }

    // 3) Normalize inbound activity (translate AP format → internal format)
    const rawActivity = {
      ...body,
      federated: true,
      remoteId: body.id || body.remoteId,
      actorId,
      _federation: { domain: sig.domain, keyId: sig.keyId },
    };
    const activity = normalizeInboundActivity(rawActivity);

    // 5) Upsert Inbox envelope (idempotent on remoteId if present)
    const remoteId = activity.remoteId;
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.ip ||
      req.socket?.remoteAddress;

    let inbox;
    if (remoteId) {
      inbox = await Inbox.findOneAndUpdate(
        { remoteId },
        {
          $setOnInsert: {
            receivedAt: new Date(),
            body,
            headers: safeHeaders(req.headers || {}),
            ttl: new Date(Date.now() + 30 * 24 * 3600 * 1000),
          },
          $set: {
            domain: sig.domain,
            keyId: sig.keyId,
            actorId: activity.actorId,
            type: activity.type,
            verified: true,
            status: { type: "accepted" },
            http: { ip, userAgent: req.get("User-Agent") },
          },
        },
        { new: true, upsert: true }
      );
    } else {
      // No remoteId provided → insert a fresh envelope (no idempotency possible)
      inbox = await Inbox.create({
        receivedAt: new Date(),
        body,
        headers: safeHeaders(req.headers || {}),
        ttl: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        domain: sig.domain,
        keyId: sig.keyId,
        actorId: activity.actorId,
        type: activity.type,
        verified: true,
        status: { type: "accepted" },
        http: { ip, userAgent: req.get("User-Agent") },
      });
    }

    // 6) Respond immediately and process asynchronously
    setStatus(202);
    set({ accepted: true });

    queueMicrotask(async () => {
      try {
        const t0 = Date.now();
        const created = await Kowloon.activities.create(activity);

        if (created?.error) {
          log.warn("INBOX create failed", {
            remoteId,
            domain: sig.domain,
            error: created.error,
          });
          await Inbox.updateOne(
            { _id: inbox._id },
            {
              $inc: { attempts: 1 },
              $set: {
                status: { type: "error", reason: "create_failed" },
                error: String(created.error),
              },
            }
          );
          return;
        }

        await Inbox.updateOne(
          { _id: inbox._id },
          {
            $set: {
              status: { type: "processed" },
              activityId: created.activity?.id,
              processedAt: new Date(),
            },
          }
        );

        // Fan-out group posts to remote member servers
        if (activity.to?.startsWith("group:")) {
          const fanoutId = remoteId || activity.id || `fanout:${Date.now()}`;
          await fanOutGroupPost(activity, fanoutId);
        }

        log.info("INBOX processed", {
          remoteId,
          domain: sig.domain,
          type: activity.type,
          ms: Date.now() - t0,
        });
      } catch (err) {
        log.warn("INBOX handler exception", {
          remoteId,
          domain: sig.domain,
          error: err?.message || String(err),
        });
        await Inbox.updateOne(
          { _id: inbox._id },
          {
            $inc: { attempts: 1 },
            $set: {
              status: { type: "error", reason: "exception" },
              error: String(err?.message || err),
            },
          }
        );
      }
    });
  },
  { allowUnauth: true }
);
