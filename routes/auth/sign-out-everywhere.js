// routes/auth/sign-out-everywhere.js
// POST /auth/sign-out-everywhere
// Ends every other session on this account (other phones, browsers, the
// old laptop) and keeps this one: tokens issued before now are rejected by
// routes/utils/route.js (tokensValidAfter), and the caller gets a fresh one.
// No password needed -- it can only take access away. Someone who fears
// their password is known should change it instead, which does the same.

import express from "express";
import route from "../utils/route.js";
import { User } from "#schema";
import generateToken from "#methods/generate/token.js";

const handler = route(
  async ({ user, set, setStatus }) => {
    if (user?.scope === "visiting") {
      setStatus(403);
      set("error", "A visiting session can't sign this account out");
      return;
    }
    // Second-aligned: iat has 1s resolution, so the fresh token below must
    // not fall before the cut-off (same as change-password.js).
    const cutoff = new Date(Math.floor(Date.now() / 1000) * 1000);
    const r = await User.updateOne({ id: user.id, active: true }, { $set: { tokensValidAfter: cutoff } });
    if (!r.matchedCount) {
      setStatus(404);
      set("error", "User not found");
      return;
    }
    set("ok", true);
    set("token", await generateToken(user.id));
  },
  { allowUnauth: false }
);

const router = express.Router({ mergeParams: true });
router.post("/sign-out-everywhere", handler);
export default router;
