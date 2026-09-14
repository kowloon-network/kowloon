// /routes/register/index.js
// Public registration endpoint (no auth).
// POST /register
// Body: { username, password, email?, profile?, ... }
// Response (JSON): { user, token }

import crypto from "crypto";
import express from "express";
import route from "#routes/utils/route.js";
import generateToken from "#methods/generate/token.js";
import getSettings from "#methods/settings/get.js";
import { User, Invite } from "#schema";
import { strictRateLimiter } from "../middleware/rateLimiter.js";
import { sendEmail } from "#methods/email/index.js";
import { verificationEmail } from "#methods/email/templates.js";

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const isNonEmpty = (s) => typeof s === "string" && s.trim().length > 0;

const PETTY_LIMITS = [
  { normalized: "ghostmountain", max: 43 },
];

function normalizeUsername(username) {
  return username.toLowerCase().replace(/[^a-z]/g, "");
}

async function checkUsernameLimit(username) {
  const normalized = normalizeUsername(username);
  for (const rule of PETTY_LIMITS) {
    if (normalized.includes(rule.normalized) || rule.normalized.includes(normalized)) {
      const regex = new RegExp(rule.normalized.split("").join("[^a-z]*"), "i");
      const count = await User.countDocuments({ username: { $regex: regex } });
      if (count >= rule.max) {
        return { allowed: false, reason: "Username unavailable" };
      }
    }
  }
  return { allowed: true };
}

function pickUserInput(body = {}) {
  // Only pick fields your schema expects to ingest directly.
  // Pre-save hook in User.js will fill id, actorId, keys, circles, etc.
  return {
    username: isNonEmpty(body.username) ? body.username.trim() : null,
    password: isNonEmpty(body.password) ? body.password : null,
    email: isNonEmpty(body.email) ? body.email.trim() : undefined,
    profile: isObj(body.profile) ? body.profile : undefined,
    to: isNonEmpty(body.to) ? body.to : undefined,
    canReply: isNonEmpty(body.canReply) ? body.canReply : undefined,
    canReact: isNonEmpty(body.canReact) ? body.canReact : undefined,
    // Add other safe fields as needed (prefs, etc.)
  };
}

function sanitizeUser(u) {
  if (!u) return null;
  const doc = u.toObject ? u.toObject() : u;
  return {
    id: doc.id, // @user@domain
    actorId: doc.actorId, // https://domain/users/username
    username: doc.username,
    email: doc.email || null,
    profile: doc.profile || {},
    following: doc.circles?.following || null,
    allFollowing: doc.circles?.allFollowing || null,
    blocked: doc.circles?.blocked || null,
    muted: doc.circles?.muted || null,
    groups: doc.circles?.groups || null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

const registerHandler = route(
  async ({ body, set, setStatus }) => {
    if (!isObj(body)) {
      setStatus(400);
      set("error", "Invalid JSON body");
      return;
    }

    const settings = await getSettings();
    const domain = settings?.domain;
    if (!isNonEmpty(domain)) {
      setStatus(500);
      set("error", "Missing settings.domain");
      return;
    }

    // Registration always requires a valid invite code — individual (one
    // named person) or "open" (a link an admin can hand out, optionally
    // unlimited-redemption). There is no server-wide open-signup switch
    // anymore: a server that wants low-friction signup issues an "open"
    // invite with maxRedemptions: null instead, which stays admin-owned
    // (trackable, revocable, expirable) rather than an unaccountable flag.
    const inviteCode = isNonEmpty(body.inviteCode) ? body.inviteCode.trim() : null;

    if (!inviteCode) {
      setStatus(403);
      set("error", "Registration requires an invite code.");
      return;
    }

    const invite = await Invite.findOne({
      code: inviteCode,
      active: true,
      deletedAt: null,
    });

    if (!invite) {
      setStatus(404);
      set("error", "Invalid invite code");
      return;
    }

    if (!invite.isValid) {
      // Determine specific reason
      let reason = "Invite is no longer valid";
      if (invite.expiresAt && new Date() > invite.expiresAt) {
        reason = "Invite has expired";
      } else if (invite.type === "individual" && invite.usedAt) {
        reason = "Invite has already been used";
      } else if (
        invite.type === "open" &&
        invite.maxRedemptions !== null &&
        invite.redemptionCount >= invite.maxRedemptions
      ) {
        reason = "Invite has reached its redemption limit";
      }
      setStatus(410);
      set("error", reason);
      return;
    }

    const input = pickUserInput(body);

    // For individual invites, verify email matches
    if (invite && invite.type === "individual") {
      if (!isNonEmpty(input.email)) {
        setStatus(400);
        set("error", "Email is required for this invite");
        return;
      }
      if (input.email.toLowerCase() !== invite.email.toLowerCase()) {
        setStatus(403);
        set("error", "This invite is for a different email address");
        return;
      }
    }

    if (!isNonEmpty(input.username)) {
      setStatus(400);
      set("error", "username is required");
      return;
    }
    // Usernames are handles — they become part of the account id (@user@domain)
    // and actor URL, so they must be a slug. Spaces/capitals here produced
    // malformed ids that broke profile edits and federation. Full names belong
    // in the display name, not the username.
    if (!/^[a-z0-9_]{2,32}$/.test(input.username)) {
      setStatus(400);
      set(
        "error",
        "Username must be 2–32 characters using only lowercase letters, numbers, or underscores (no spaces or capitals). Put your full name in the display name instead."
      );
      return;
    }
    if (!isNonEmpty(input.password)) {
      setStatus(400);
      set("error", "password is required");
      return;
    }

    // Compute the canonical id that your pre-save hook will set, so we can dupe-check.
    const expectedId = `@${input.username}@${domain}`;

    // Prevent duplicates by username or id
    const existing = await User.findOne({
      $or: [{ username: input.username }, { id: expectedId }],
    }).lean();
    if (existing) {
      setStatus(409);
      set("error", "User already exists");
      return;
    }

    const limitCheck = await checkUsernameLimit(input.username);
    if (!limitCheck.allowed) {
      setStatus(409);
      set("error", limitCheck.reason);
      return;
    }

    const requireEmailVerification = settings.requireEmailVerification === true;

    if (requireEmailVerification && !isNonEmpty(input.email)) {
      setStatus(400);
      set("error", "email is required");
      return;
    }

    // Rules acknowledgement: every server rule's id must appear in the
    // submitted acknowledgedRules array. Store a snapshot so a later rules
    // edit doesn't rewrite the user's consent history.
    const currentRules = Array.isArray(settings.rules) ? settings.rules : [];
    let acknowledgedRules = [];
    if (currentRules.length > 0) {
      const submitted = Array.isArray(body.acknowledgedRules) ? body.acknowledgedRules : [];
      const submittedIds = new Set(submitted.map(String));
      const missing = currentRules.filter((r) => !submittedIds.has(r.id));
      if (missing.length > 0) {
        setStatus(400);
        set("error", "You must acknowledge all server rules to register.");
        return;
      }
      const now = new Date();
      acknowledgedRules = currentRules.map((r) => ({
        id: r.id,
        text: r.text,
        acknowledgedAt: now,
      }));
    }

    let verificationToken;
    if (requireEmailVerification) {
      verificationToken = crypto.randomBytes(32).toString("hex");
    }

    // Create; your User pre-save hook will:
    // - hash password if modified
    // - set id (@user@domain), actorId (URL), url, server/domain/jwksUrl
    // - generate RSA keypair if missing
    // - create following/allFollowing/blocked/muted circles
    const created = await User.create({
      username: input.username,
      password: input.password,
      email: input.email,
      profile: input.profile,
      to: input.to,
      canReply: input.canReply,
      canReact: input.canReact,
      acknowledgedRules,
      ...(requireEmailVerification && {
        emailVerified: false,
        emailVerificationToken: verificationToken,
        emailVerificationExpires: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }),
    });

    // Redeem the invite if one was used
    if (invite) {
      try {
        await invite.redeem(created.id, input.email);
      } catch (err) {
        // Log but don't fail registration - user is already created
        console.error("Failed to redeem invite after registration:", err.message);
      }
    }

    if (requireEmailVerification) {
      const verifyUrl = `https://${domain}/verify-email?token=${verificationToken}`;
      try {
        const { subject, html } = verificationEmail({ verifyUrl });
        await sendEmail({ to: input.email, subject, html });
      } catch (err) {
        console.error("Failed to send verification email:", err.message);
      }

      setStatus(201);
      set("requiresVerification", true);
      set("message", "Account created. Please check your email to verify your address before logging in.");
      return;
    }

    // Generate a full token (same shape as login) so the client gets profile,
    // following circle ID, muted/blocked lists, etc. immediately after registration.
    let token;
    try {
      token = await generateToken(created.id);
    } catch (err) {
      setStatus(500);
      set("error", `Token generation failed: ${err.message}`);
      return;
    }

    const user = sanitizeUser(created);

    setStatus(201);
    set("user", user);
    set("token", token);
  },
  {
    // Allow unauthenticated POST for registration
    allowUnauth: true,
    label: "REGISTER",
  }
);

const router = express.Router({ mergeParams: true });
router.use(strictRateLimiter);
router.post("/", registerHandler);
export default router;
