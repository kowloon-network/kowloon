// routes/auth/delete-account.js
// POST /auth/delete-account  { password }
//
// Self-service account deletion (Apple App Store Guideline 5.1.1(v)): must
// be initiatable from inside the app and must actually remove the account
// and its data, not just deactivate it. See methods/users/deleteAccountCascade.js
// for what "removes the data" means here -- local-only, no federation push.
import express from "express";
import route from "../utils/route.js";
import { User } from "#schema";
import deleteAccountCascade from "#methods/users/deleteAccountCascade.js";

const handler = route(
  async ({ body, user, set, setStatus }) => {
    // Same guard as change-password.js: a visiting cross-server OAuth
    // session must never be able to take over -- or here, destroy -- the
    // home account.
    if (user?.scope === "visiting") {
      setStatus(403);
      set("error", "A visiting session cannot delete your account");
      return;
    }

    const password = typeof body?.password === "string" ? body.password : null;
    if (!password) {
      setStatus(400);
      set("error", "password is required");
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

    // Lock the account out FIRST -- revocation (routes/utils/route.js) takes
    // effect immediately on the next request, even if the cascade below is
    // still running or fails partway through a prolific user's content.
    await User.updateOne(
      { id: user.id },
      { $set: { active: false, deletedAt: new Date(), deletedBy: user.id } }
    );

    const result = await deleteAccountCascade(user.id);
    if (!result.ok) {
      // Cascade refused (e.g. sole admin owning a Group) -- undo the lock so
      // the account isn't left stranded over a blocked deletion.
      await User.updateOne(
        { id: user.id },
        { $set: { active: true }, $unset: { deletedAt: "", deletedBy: "" } }
      );
      setStatus(409);
      set("error", result.error);
      return;
    }

    set("ok", true);
  },
  { allowUnauth: false }
);

const router = express.Router({ mergeParams: true });
router.post("/delete-account", handler);
export default router;
