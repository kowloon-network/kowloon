// routes/admin/invites.js
// Admin invite management — all routes require server admin

import route from "../utils/route.js";
import { Invite } from "#schema";
import { activityStreamsCollection } from "../utils/oc.js";
import { getSetting } from "#methods/settings/cache.js";
import { sendEmail } from "#methods/email/index.js";
import { inviteEmail } from "#methods/email/templates.js";
import logger from "#methods/utils/logger.js";

function sanitizeInvite(invite) {
  const doc = invite.toObject ? invite.toObject() : invite;
  return {
    id: doc.id,
    type: doc.type,
    code: doc.code,
    url: doc.url,
    qrCode: doc.qrCode,
    email: doc.email || null,
    note: doc.note || null,
    welcomeMessage: doc.welcomeMessage || null,
    active: doc.active,
    expiresAt: doc.expiresAt || null,
    maxRedemptions: doc.maxRedemptions ?? null,
    redemptionCount: doc.redemptionCount,
    // Individual invite fields
    usedAt: doc.usedAt || null,
    usedBy: doc.usedBy || null,
    // Open invite redemption list
    redemptions: doc.redemptions || [],
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// Known fields per invite type. A caller sending an unrecognized field name
// (e.g. a typo'd `amount` instead of `maxRedemptions`) gets a 400 instead of
// having it silently dropped — for `type: "open"`, a dropped maxRedemptions
// is indistinguishable from an intentional unlimited invite, which bit the
// client SDK once already (see issue #46).
const ALLOWED_FIELDS = {
  individual: new Set(["type", "email", "expiresAt", "note", "welcomeMessage"]),
  open: new Set(["type", "maxRedemptions", "expiresAt", "note", "welcomeMessage"]),
};

// POST /admin/invites — create an individual or open invite
export const create = route(
  async ({ body, user, set, setStatus }) => {
    const { type = "individual", email, maxRedemptions, expiresAt, note, welcomeMessage } = body;

    if (type !== "individual" && type !== "open") {
      setStatus(400);
      set("error", "type must be 'individual' or 'open'");
      return;
    }

    const unrecognized = Object.keys(body).filter((k) => !ALLOWED_FIELDS[type].has(k));
    if (unrecognized.length > 0) {
      setStatus(400);
      set("error", `Unrecognized field(s) for type '${type}': ${unrecognized.join(", ")}`);
      return;
    }

    if (type === "individual" && !email) {
      setStatus(400);
      set("error", "email is required for individual invites");
      return;
    }

    // maxRedemptions omitted (or null/"") intentionally means unlimited —
    // that's a real, legitimate choice, not the bug. The bug was a typo'd
    // field name silently producing the exact same result; the allowlist
    // check above is what actually closes that. This just rejects a
    // provided-but-nonsensical value (e.g. 0, negative, non-numeric).
    let maxRedemptionsValue = null;
    if (type === "open" && maxRedemptions !== undefined && maxRedemptions !== null && maxRedemptions !== "") {
      const n = Number(maxRedemptions);
      if (!Number.isInteger(n) || n < 1) {
        setStatus(400);
        set("error", "maxRedemptions must be a positive integer, or omitted for unlimited");
        return;
      }
      maxRedemptionsValue = n;
    }

    let invite;
    if (type === "individual") {
      invite = await Invite.createIndividual(user.id, email, {
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        note,
        welcomeMessage,
      });
    } else {
      invite = await Invite.createOpen(user.id, {
        maxRedemptions: maxRedemptionsValue,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        note,
        welcomeMessage,
      });
    }

    // Send invite email for individual invites
    if (type === "individual") {
      try {
        const { subject, html } = inviteEmail({
          inviteUrl: invite.url,
          email,
          welcomeMessage,
          note,
        });
        await sendEmail({ to: email, subject, html });
      } catch (err) {
        logger.warn(`[invites] Failed to send invite email to ${email}: ${err.message}`);
      }
    }

    setStatus(201);
    set("invite", sanitizeInvite(invite));
  },
  { allowUnauth: false }
);

// GET /admin/invites — list invites
export const list = route(
  async ({ query, set }) => {
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(Math.max(1, parseInt(query.limit, 10) || 20), 100);
    const skip = (page - 1) * limit;

    const filter = { deletedAt: null };
    if (query.type) filter.type = query.type;
    if (query.active !== undefined) filter.active = query.active !== "false";

    const [docs, total] = await Promise.all([
      Invite.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Invite.countDocuments(filter),
    ]);

    const domain = getSetting("domain");
    const collection = activityStreamsCollection({
      id: `https://${domain}/admin/invites?page=${page}`,
      orderedItems: docs.map(sanitizeInvite),
      totalItems: total,
      page,
      itemsPerPage: limit,
      baseUrl: `https://${domain}/admin/invites`,
    });

    for (const [key, value] of Object.entries(collection)) {
      set(key, value);
    }
  },
  { allowUnauth: false }
);

// GET /admin/invites/:id — get a single invite
export const getOne = route(
  async ({ params, set, setStatus }) => {
    const invite = await Invite.findOne({
      id: decodeURIComponent(params.id),
      deletedAt: null,
    });

    if (!invite) {
      setStatus(404);
      set("error", "Invite not found");
      return;
    }

    set("invite", sanitizeInvite(invite));
  },
  { allowUnauth: false }
);

// DELETE /admin/invites/:id — deactivate an invite
export const deactivate = route(
  async ({ params, set, setStatus }) => {
    const invite = await Invite.findOne({
      id: decodeURIComponent(params.id),
      deletedAt: null,
    });

    if (!invite) {
      setStatus(404);
      set("error", "Invite not found");
      return;
    }

    invite.active = false;
    invite.deletedAt = new Date();
    await invite.save();

    set("ok", true);
    set("invite", sanitizeInvite(invite));
  },
  { allowUnauth: false }
);
