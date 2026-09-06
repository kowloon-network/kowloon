// /ActivityParser/handlers/Flag/index.js

import { Flag } from "#schema";
import getObjectById from "#methods/core/getObjectById.js";
import kowloonId from "#methods/parse/kowloonId.js";
import Settings from "#schema/Settings.js";

export default async function FlagHandler(activity) {
  try {
    // ---- Basic validation ----
    if (!activity?.actorId || typeof activity.actorId !== "string") {
      return { activity, error: "Flag: missing activity.actorId" };
    }
    if (!activity?.target || typeof activity.target !== "string") {
      return { activity, error: "Flag: missing or malformed activity.target" };
    }
    if (!activity?.object) {
      return { activity, error: "Flag: missing activity.object (reason)" };
    }

    // ---- Load flagOptions from Settings (canonical record) ----
    const flagOptions = await loadFlagOptions(); // { code -> {label, description} }
    if (!flagOptions) {
      return { activity, error: "Flag: server flagOptions not configured" };
    }

    // ---- Normalize & validate reason against flagOptions ----
    const { reason: rawReason, notes } = activity.object || {};
    const reason = normalizeReason(rawReason, flagOptions);
    if (!reason) {
      return { activity, error: "Flag: invalid or unsupported object.reason" };
    }

    // ---- Identify target & federation signal ----
    // getObjectById returns { object, source, visibility, cached }, not the
    // raw document -- targetDoc.actorId/.objectType/.type were always
    // undefined (wrong property path), so targetActorId has never actually
    // been populated on any flag. targetType happened to still come out
    // right by accident, via the kowloonId(...) fallback below.
    let targetDoc = null;
    try {
      targetDoc = await getObjectById(activity.target);
    } catch {
      targetDoc = null; // not found / remote / not visible -- fall through
    }
    const targetObject = targetDoc?.object;
    const parsedTarget = kowloonId(activity.target);
    const ourDomain = await getOurDomain();

    const targetType =
      targetObject?.objectType ||
      targetObject?.type ||
      (parsedTarget?.type && capitalize(parsedTarget.type)) ||
      undefined;

    const targetActorId = targetObject?.actorId || undefined;

    const isTargetRemote =
      !targetDoc ||
      (parsedTarget?.domain && ourDomain && parsedTarget.domain !== ourDomain);

    // ---- De-dupe: same actor, same target, open flag, same reason.code ----
    const existing = await Flag.findOne({
      target: activity.target,
      actorId: activity.actorId,
      status: "open",
      "reason.code": reason.code,
    }).lean();

    if (existing) {
      activity.objectId = existing.id;
      // no sideEffects on duplicate -- Undo should not try to mutate anything
      return {
        activity,
        flag: existing,
        duplicated: true,
        federate: isTargetRemote, // may still need to notify remote if never sent
      };
    }

    // ---- Create the flag ----
    const flag = await Flag.create({
      target: activity.target,
      targetType,
      targetActorId,
      reason, // { code, label, description, details? }
      notes: typeof notes === "string" ? notes : undefined,
      actorId: activity.actorId,
      status: "open",
      server: ourDomain || undefined, // lets pre('save') mint id like flag:<...>@host
    });

    // annotate for downstreams + Undo
    activity.objectId = flag.id;

    return { activity, flag, federate: isTargetRemote };
  } catch (err) {
    return { activity, error: err?.message || String(err) };
  }
}

/* ---------------- helpers ---------------- */

async function loadFlagOptions() {
  const rec = await Settings.findOne({ name: "flagOptions" }).lean();
  const val = rec?.value;
  if (!val || typeof val !== "object") return null;
  // normalize keys to lower_snake just in case
  const out = {};
  for (const [code, meta] of Object.entries(val)) {
    if (!meta || typeof meta !== "object") continue;
    out[String(code).trim().toLowerCase()] = {
      label: typeof meta.label === "string" ? meta.label : String(code),
      description:
        typeof meta.description === "string" ? meta.description : undefined,
    };
  }
  return out;
}

// Accepts either a string code OR an object; validates against flagOptions.
// If the string isn't a known code but matches a label (case-insensitive), map to that code.
// Otherwise, fall back to 'other' with details retained (if configured).
function normalizeReason(raw, flagOptions) {
  if (!raw) return null;

  const mapByLabel = new Map(
    Object.entries(flagOptions).map(([code, meta]) => [
      meta.label.toLowerCase(),
      code,
    ])
  );

  if (typeof raw === "string") {
    const key = raw.trim().toLowerCase();
    if (!key) return null;

    // direct code?
    if (flagOptions[key]) {
      const meta = flagOptions[key];
      return { code: key, label: meta.label, description: meta.description };
    }

    // label match?
    const byLabel = mapByLabel.get(key);
    if (byLabel && flagOptions[byLabel]) {
      const meta = flagOptions[byLabel];
      return {
        code: byLabel,
        label: meta.label,
        description: meta.description,
      };
    }

    // fallback to other
    if (flagOptions["other"]) {
      const meta = flagOptions["other"];
      return {
        code: "other",
        label: meta.label,
        description: meta.description,
        details: raw,
      };
    }
    return null;
  }

  if (typeof raw === "object") {
    const code =
      typeof raw.code === "string" ? raw.code.trim().toLowerCase() : undefined;
    const label = typeof raw.label === "string" ? raw.label.trim() : undefined;
    const details = typeof raw.details === "string" ? raw.details : undefined;

    // prefer code validation
    if (code && flagOptions[code]) {
      const meta = flagOptions[code];
      return {
        code,
        label: meta.label,
        description: meta.description,
        ...(details && { details }),
      };
    }

    // try label mapping
    if (label) {
      const byLabel = (label || "").toLowerCase();
      const mapped = mapByLabel.get(byLabel);
      if (mapped && flagOptions[mapped]) {
        const meta = flagOptions[mapped];
        return {
          code: mapped,
          label: meta.label,
          description: meta.description,
          ...(details && { details }),
        };
      }
    }

    // fallback to other
    if (flagOptions["other"]) {
      const meta = flagOptions["other"];
      return {
        code: "other",
        label: meta.label,
        description: meta.description,
        ...(label && { details: label }),
        ...(details && { details }),
      };
    }
    return null;
  }

  return null;
}

async function getOurDomain() {
  const s = await Settings.findOne({ name: "domain" }).lean();
  return s?.value || undefined;
}

function capitalize(s) {
  if (!s || typeof s !== "string") return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
