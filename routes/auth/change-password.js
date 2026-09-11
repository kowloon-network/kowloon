// routes/auth/change-password.js
// POST /auth/change-password  { currentPassword, newPassword }
// Logged-in password change. Distinct from reset-password.js, which is the
// emailed-token path for people who can't log in at all.

import express from "express";
import route from "../utils/route.js";
import { User } from "#schema";
import generateToken from "#methods/generate/token.js";

const handler = route(
  async ({ body, user, set, setStatus }) => {
    // A scope:"visiting" token belongs to a FOREIGN server acting on this
    // user's behalf via cross-server OAuth — it must never be able to take
    // over the account. Interaction-shaped activities are all a visiting
    // session is ever granted (see routes/outbox/post.js), and that check
    // only guards /outbox, so this route has to refuse them itself.
    if (user?.scope === "visiting") {
      setStatus(403);
      set("error", "A visiting session cannot change your password");
      return;
    }

    const currentPassword =
      typeof body.currentPassword === "string" ? body.currentPassword : null;
    const newPassword =
      typeof body.newPassword === "string" ? body.newPassword : null;

    if (!currentPassword || !newPassword) {
      setStatus(400);
      set("error", "currentPassword and newPassword are required");
      return;
    }

    // Same floor as reset-password.js — keep the two paths in step.
    if (newPassword.length < 8) {
      setStatus(400);
      set("error", "Password must be at least 8 characters");
      return;
    }

    if (newPassword === currentPassword) {
      setStatus(400);
      set("error", "New password must be different from your current one");
      return;
    }

    const userDoc = await User.findOne({ id: user.id, active: true });

    if (!userDoc) {
      setStatus(404);
      set("error", "User not found");
      return;
    }

    if (!(await userDoc.verifyPassword(currentPassword))) {
      setStatus(400);
      set("error", "Current password is incorrect");
      return;
    }

    // The pre-save hook hashes password when it's modified.
    userDoc.password = newPassword;
    // Any outstanding emailed reset link is stale once the password changes.
    userDoc.passwordResetToken = undefined;
    userDoc.passwordResetExpires = undefined;
    await userDoc.save();

    // Hand back a fresh token so the caller's current session survives the
    // change. Tokens are stateless RS256 JWTs, so previously-issued ones stay
    // valid until they expire — this does NOT sign other sessions out.
    const authToken = await generateToken(userDoc.id);
    set("ok", true);
    set("token", authToken);
  },
  { allowUnauth: false }
);

const router = express.Router({ mergeParams: true });
router.post("/change-password", handler);
export default router;
