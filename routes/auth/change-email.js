// routes/auth/change-email.js
// POST /auth/change-email  { password, email }
//
// Logged-in email change. Asks for the current password because the email
// address is how an account is recovered: whoever controls it can reset the
// password, so a stolen session must not be able to repoint it. (That's
// also why the Update activity no longer lets a user change their own email.)
//
// The new address starts unverified and gets a verification link, the same
// flow registration uses. Login is only gated on verification when the
// server's requireEmailVerification setting is on.

import express from "express";
import crypto from "crypto";
import route from "../utils/route.js";
import { User } from "#schema";
import { isEmailBanned } from "#methods/moderation/blocklist.js";
import { getSetting } from "#methods/settings/cache.js";
import { sendEmail } from "#methods/email/index.js";
import { verificationEmail } from "#methods/email/templates.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const handler = route(
  async ({ body, user, set, setStatus }) => {
    if (user?.scope === "visiting") {
      setStatus(403);
      set("error", "A visiting session cannot change your email");
      return;
    }

    const password = typeof body?.password === "string" ? body.password : "";
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!password || !email) {
      setStatus(400);
      set("error", "Your password and the new email address are required");
      return;
    }
    if (!EMAIL_RE.test(email)) {
      setStatus(400);
      set("error", "That doesn't look like an email address");
      return;
    }

    const userDoc = await User.findOne({ id: user.id, active: true });
    if (!userDoc) {
      setStatus(404);
      set("error", "User not found");
      return;
    }
    if (!(await userDoc.verifyPassword(password))) {
      setStatus(400);
      set("error", "Incorrect password");
      return;
    }
    if (email === String(userDoc.email || "").toLowerCase()) {
      setStatus(400);
      set("error", "That's already your email address");
      return;
    }
    if (await isEmailBanned(email)) {
      setStatus(400);
      set("error", "That email address can't be used on this server");
      return;
    }
    if (await User.exists({ email, id: { $ne: user.id } })) {
      setStatus(409);
      set("error", "Another account already uses that email address");
      return;
    }

    const token = crypto.randomBytes(32).toString("hex");
    await User.updateOne(
      { id: user.id },
      {
        $set: {
          email,
          emailVerified: false,
          emailVerificationToken: token,
          emailVerificationExpires: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      }
    );

    let sent = true;
    try {
      const verifyUrl = `https://${getSetting("domain")}/verify-email?token=${token}`;
      const { subject, html } = verificationEmail({ verifyUrl });
      await sendEmail({ to: email, subject, html });
    } catch (err) {
      sent = false;
      console.error("change-email: failed to send verification email:", err.message);
    }

    set("ok", true);
    set("email", email);
    set("verificationSent", sent);
  },
  { allowUnauth: false }
);

const router = express.Router({ mergeParams: true });
router.post("/change-email", handler);
export default router;
