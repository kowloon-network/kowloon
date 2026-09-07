import express from "express";
import authorize from "./authorize.js";
import token from "./token.js";
import exchange from "./exchange.js";

const router = express.Router({ mergeParams: true });

router.post("/authorize", authorize); // local session required — mints a code
router.use("/token", token); // S2S only — HTTP-signature authenticated
router.post("/exchange", exchange); // consumer-side code exchange (unauthenticated)

export default router;
