// /routes/auth/index.js
import express from "express";
import loginRouter from "./login.js";
import forgotPasswordRouter from "./forgot-password.js";
import resetPasswordRouter from "./reset-password.js";
import verifyEmailRouter from "./verify-email.js";
import resendVerificationRouter from "./resend-verification.js";
import meRoute from "./me.js";
import { strictRateLimiter } from "../middleware/rateLimiter.js";

const router = express.Router({ mergeParams: true });

// /me is session-restore — must not be rate-limited
router.get("/me", meRoute);

// verify-email uses GET with a token in the query string — no rate limit needed here
// since tokens are single-use 32-byte random values
router.use("/", verifyEmailRouter);

router.use(strictRateLimiter);

// login.js exports a bare route handler, NOT an express.Router — mounting it
// with router.use("/") made it catch-all middleware for every path under
// /auth, and since it always responds instead of calling next(), it swallowed
// every route registered below it: forgot-password, reset-password and
// resend-verification all answered "Unsupported fields: ..." from login's
// strict body check and were completely unreachable in production. Mount it
// at its own path, the way the equally-bare me.js already is.
router.post("/login", loginRouter);
router.use("/", forgotPasswordRouter);
router.use("/", resetPasswordRouter);
router.use("/", resendVerificationRouter);

export default router;
