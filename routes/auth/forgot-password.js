// routes/auth/forgot-password.js
// POST /auth/forgot-password  { email }
// Always returns 200 (no email enumeration).

import crypto from "crypto";
import express from "express";
import route from "../utils/route.js";
import { User } from "#schema";
import { getSetting } from "#methods/settings/cache.js";
import { sendEmail } from "#methods/email/index.js";
import { passwordResetEmail } from "#methods/email/templates.js";
import logger from "#methods/utils/logger.js";

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

const handler = route(
  async ({ body, set }) => {
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : null;

    set("ok", true);
    set("message", "If that email is registered, a reset link has been sent.");

    if (!email) return;

    // Exact, case-insensitive match via collation -- never build a RegExp from
    // user input ("." / "*" etc. would match other addresses, and patterns
    // like (a+)+ are a ReDoS vector).
    const user = await User.findOne({ email, active: true })
      .collation({ locale: "en", strength: 2 })
      .select("+passwordResetToken +passwordResetExpires")
      .lean(false);

    if (!user) return;

    const token = crypto.randomBytes(32).toString("hex");
    user.passwordResetToken = token;
    user.passwordResetExpires = new Date(Date.now() + TOKEN_TTL_MS);
    await user.save();

    const domain = getSetting("domain") || "localhost";
    const proto = domain === "localhost" ? "http" : "https";
    const resetUrl = `${proto}://${domain}/reset-password?token=${token}`;

    try {
      const { subject, html } = passwordResetEmail({ resetUrl });
      await sendEmail({ to: user.email, subject, html });
    } catch (err) {
      logger.warn(`[forgot-password] Failed to send reset email to ${user.email}: ${err.message}`);
    }
  },
  { allowUnauth: true }
);

const router = express.Router({ mergeParams: true });
router.post("/forgot-password", handler);
export default router;
