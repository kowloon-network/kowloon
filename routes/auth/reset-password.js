// routes/auth/reset-password.js
// POST /auth/reset-password  { token, password }

import express from "express";
import route from "../utils/route.js";
import { User } from "#schema";
import generateToken from "#methods/generate/token.js";

const handler = route(
  async ({ body, set, setStatus }) => {
    const token = typeof body.token === "string" ? body.token.trim() : null;
    const password = typeof body.password === "string" ? body.password : null;

    if (!token || !password) {
      setStatus(400);
      set("error", "token and password are required");
      return;
    }

    if (password.length < 8) {
      setStatus(400);
      set("error", "Password must be at least 8 characters");
      return;
    }

    const user = await User.findOne({
      passwordResetToken: token,
      passwordResetExpires: { $gt: new Date() },
      active: true,
    }).select("+passwordResetToken +passwordResetExpires");

    if (!user) {
      setStatus(400);
      set("error", "Reset token is invalid or has expired");
      return;
    }

    user.password = password;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    // Sign out every other session: tokens issued before this second are
    // rejected by routes/utils/route.js. Second-aligned so the fresh token
    // returned below (iat has 1s resolution) stays valid.
    user.tokensValidAfter = new Date(Math.floor(Date.now() / 1000) * 1000);
    await user.save();

    const authToken = await generateToken(user.id);
    set("ok", true);
    set("token", authToken);
  },
  { allowUnauth: true }
);

const router = express.Router({ mergeParams: true });
router.post("/reset-password", handler);
export default router;
