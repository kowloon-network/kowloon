// /routes/outbox/post.js
import route from "../utils/route.js";
import Kowloon from "#kowloon";
import getSettings from "#methods/settings/get.js";
import createActivity from "#methods/activities/create.js"; // fallback creator

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const isNonEmptyStr = (s) => typeof s === "string" && s.trim().length > 0;

// AS2 attachment `type` values, from our internal per-attachment `kind`
// (schema/subschema/Attachment.js).
const ATTACHMENT_AS2_TYPE = { photo: "Image", video: "Video", audio: "Audio", file: "Document" };

// Before federating, replace internal file: IDs with public HTTP URLs so remote
// servers can fetch media without needing access to our internal ID scheme, and
// emit real AS2 `attachment` objects (not our internal storage shape) so peers
// get real mediaType/name metadata over the wire (#53).
function resolveFileIdsForFederation(activity, domain) {
  if (!activity?.object || !domain) return activity;
  const obj = activity.object;
  const toUrl = (id) =>
    id?.startsWith("file:") ? `https://${domain}/files/${encodeURIComponent(id)}` : id;

  const toAS2Attachment = (a) => {
    // Our internal resolved Attachment subdocument shape.
    if (a && typeof a === "object" && a.fileId) {
      const url = toUrl(a.fileId);
      if (!url) return null;
      return {
        type: ATTACHMENT_AS2_TYPE[a.kind] ?? "Document",
        url,
        ...(a.mediaType ? { mediaType: a.mediaType } : {}),
        ...(a.name ? { name: a.name } : {}),
      };
    }
    // Legacy/unmigrated bare fileId or proxy-URL string — no rich metadata available.
    if (typeof a === "string") {
      const url = toUrl(a);
      return url ? { type: "Document", url } : null;
    }
    return null;
  };

  const clone = { ...activity, object: { ...obj } };
  if (typeof obj.image === "string") clone.object.image = toUrl(obj.image);
  if (Array.isArray(obj.attachments)) {
    clone.object.attachment = obj.attachments.map(toAS2Attachment).filter(Boolean);
    delete clone.object.attachments;
  }
  return clone;
}
const DEV =
  process.env.NODE_ENV === "development" ||
  /^(1|true|yes)$/i.test(process.env.OUTBOX_DEBUG || "");

function isCreateUserActivity(body) {
  if (!isObj(body)) return false;
  if (body.type !== "Create") return false;
  if (body.objectType === "User") return true;
  const ot = body?.object?.type;
  return typeof ot === "string" && /^(User|Person)$/i.test(ot);
}

function pickCreateFn() {
  const viaKowloon = Kowloon?.activities?.create;
  return typeof viaKowloon === "function" ? viaKowloon : createActivity;
}

export default route(
  async ({ req, body, user, set, setStatus }) => {
    const rid = Math.random().toString(36).slice(2, 8);
    const label = `OUTBOX ${rid}`;
    console.time(label);

    const unauthCreateUser = isCreateUserActivity(body);

    // ---- settings for server actor ----
    const settings = await getSettings().catch(() => ({}));
    const domain = settings?.domain;

    // Build activity without mutating req.body
    const activity = { ...(body || {}) };

    // Enforce actor:
    // - For Create->User, force server actor (e.g. "@kwln.org")
    // - Otherwise, enforce the authenticated user
    if (unauthCreateUser) {
      if (isNonEmptyStr(domain)) {
        activity.actorId = `@${domain}`;
      } else if (!isNonEmptyStr(activity.actorId)) {
        setStatus(400);
        set("error", "Create User: missing server actor (settings.domain)");
        if (DEV)
          console.error(
            `${label}: 400 Create User missing server actor (settings.domain)`
          );
        console.timeEnd(label);
        return;
      }
    } else {
      activity.actorId = user.id;
      // Only set actor from JWT if client didn't already supply one
      if (!activity.actor?.id) {
        const baseUrl = domain ? `https://${domain}` : '';
        const userPath = `${baseUrl}/users/${encodeURIComponent(user.id)}`;
        activity.actor = {
          id: user.id,
          type: user.type ?? 'Person',
          name: user.profile?.name ?? user.username,
          icon: user.profile?.icon ?? null,
          url: `${baseUrl}/users/${encodeURIComponent(user.id)}`,
          inbox: `${userPath}/inbox`,
          outbox: `${userPath}/outbox`,
          server: `@${domain}`,
        };
      }
    }

    // Ensure to/canReact/canReply exist on the activity (don't override if present).
    // Default to the actor's own id, not "" — canSeeObject() treats an empty/missing
    // `to` as server-wide visible (methods/visibility/helpers.js), so an unspecified
    // audience used to silently mean "visible to everyone on the server" rather than
    // "private." Defaulting to the actor's own id makes the safe default actually
    // private: canSeeObject()'s owner-always-sees-own-content check still applies to
    // the actor, and everyone else falls through to its final `return false`.
    //
    // Deliberately activity-level only — do NOT also inject into activity.object.
    // The client (createPost et al.) has always sent to/canReply/canReact at the
    // activity level only, leaving object.to/canReply/canReact unset. Create's own
    // handler copies activity.to down onto object.to precisely when object.to is
    // falsy/"" (see ActivityParser/handlers/Create/index.js) — pre-filling object.to
    // here with a truthy value defeats that fallback and makes Create silently keep
    // the wrong (private-to-actor) value even when activity.to correctly says
    // "@public". Regressed exactly this way once already; don't reintroduce it.
    if (!("to" in activity)) activity.to = activity.actorId;
    if (!("canReact" in activity)) activity.canReact = activity.actorId;
    if (!("canReply" in activity)) activity.canReply = activity.actorId;

    // Normalize shorthand audience values → ActivityStreams-style addressing
    if (activity.to === "public") activity.to = "@public";
    if (activity.to === "server" && isNonEmptyStr(domain)) activity.to = `@${domain}`;

    if (DEV) {
      console.log(
        `${label}: normalized activity`,
        JSON.stringify(activity, null, 2)
      );
    }

    const createFn = pickCreateFn();
    const creatorPath =
      createFn === Kowloon?.activities?.create
        ? "Kowloon.activities.create"
        : "#methods/activities/create";
    if (DEV) console.log(`${label}: using creator`, creatorPath);

    if (typeof createFn !== "function") {
      setStatus(500);
      set("error", "Server not initialized: activities.create unavailable");
      if (DEV)
        console.error(`${label}: 500 no activity create function available`);
      console.timeEnd(label);
      return;
    }

    let created;
    try {
      created = await createFn(activity);
    } catch (err) {
      setStatus(500);
      set("error", err?.message || String(err));
      if (DEV) console.error(`${label}: create threw`, err?.stack || err);
      console.timeEnd(label);
      return;
    }

    if (!created || created.error) {
      // Handlers can signal a specific status via result.status (e.g. the
      // Reply/React authorization gate returns 404 for visibility/block
      // denials, 403 for a disabled canReply/canReact) — methods/activities/
      // create.js passes the handler's full return through as `result`.
      // Every other handler's plain-string error has no result.status, so
      // this falls back to 400 exactly as before — no behavior change there.
      setStatus(created?.result?.status || 400);
      set("error", created?.error || "Failed to create activity");
      if (DEV)
        console.error(
          `${label}: creator returned error`,
          JSON.stringify(created, null, 2)
        );
      console.timeEnd(label);
      return;
    }

    const createdId =
      created?.result?.created?.id ||
      created?.result?.id ||
      created?.activity?.object?.id ||
      created?.activity?.id;

    // Handle outbound federation if needed
    let federationJob = null;
    if (created.federate && createdId) {
      try {
        const { default: enqueueOutbox } = await import(
          "#methods/federation/enqueueOutbox.js"
        );
        const settings = await getSettings();
        const federationActivity = resolveFileIdsForFederation(created.activity, settings?.domain);
        federationJob = await enqueueOutbox({
          activity: federationActivity,
          activityId: createdId,
          actorId: activity.actorId,
          federation: created.federation,
          reason: "activity.federate = true",
        });
        if (DEV) {
          console.log(`${label}: federation enqueued`, {
            jobId: federationJob.jobId,
            recipients: federationJob.recipients.length,
          });
        }
      } catch (err) {
        if (DEV) {
          console.error(`${label}: federation enqueue failed`, err);
        }
        // Don't fail the whole request if federation fails
      }
    }

    setStatus(200);
    set("ok", true);
    set("activity", created.activity);
    set("result", created.result?.created || created.result);
    if (createdId) set("createdId", createdId);
    set("federate", !!created.federate);
    if (created.duplicated) set("duplicated", true);
    if (federationJob) {
      set("federationJob", {
        jobId: federationJob.jobId,
        recipients: federationJob.recipients.length,
        counts: federationJob.counts,
      });
    }

    if (DEV) {
      console.log(`${label}: success`, {
        status: 200,
        createdId: createdId || null,
        federate: !!created.federate,
        federationJob: federationJob?.jobId || null,
      });
    }
    console.timeEnd(label);
  },
  { allowUnauthCreateUser: true, label: "OUTBOX" }
);
