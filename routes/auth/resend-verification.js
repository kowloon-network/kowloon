// POST /auth/resend-verification
// Resends email verification link. Always returns 200 to prevent enumeration.

import crypto from "crypto";
import express from "express";
import route from "#routes/utils/route.js";
import { User } from "#schema";
import { getSetting } from "#methods/settings/cache.js";
import { sendEmail } from "#methods/email/index.js";
import { verificationEmail } from "#methods/email/templates.js";

const resendVerificationHandler = route(
  async ({ body, set, setStatus }) => {
    const email =
      typeof body?.email === "string" ? body.email.trim().toLowerCase() : null;

    setStatus(200);
    set("message", "If that address is registered and unverified, a new verification email has been sent.");

    if (!email) return;

    // Not gated on requireEmailVerification: change-email sends a link
    // whatever that setting is, so an unverified address must be able to ask
    // for a fresh one too (the app's Email screen offers this). Still only
    // for unverified addresses, and /auth is strictly rate-limited.
    const userDoc = await User.findOne({ email, emailVerified: false })
      .select("id email emailVerified emailVerificationToken emailVerificationExpires");
    if (!userDoc) return;

    const domain = getSetting("domain");
    const token = crypto.randomBytes(32).toString("hex");
    userDoc.emailVerificationToken = token;
    userDoc.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await userDoc.save();

    const verifyUrl = `https://${domain}/verify-email?token=${token}`;
    try {
      const { subject, html } = verificationEmail({ verifyUrl });
      await sendEmail({ to: email, subject, html });
    } catch (err) {
      console.error("Failed to resend verification email:", err.message);
    }
  },
  { allowUnauth: true, label: "RESEND_VERIFICATION" }
);

const router = express.Router({ mergeParams: true });
router.post("/resend-verification", resendVerificationHandler);
export default router;
