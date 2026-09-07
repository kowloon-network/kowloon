import express from "express";
import authorize from "./authorize.js";
import token from "./token.js";
import exchange from "./exchange.js";
import grants from "./grants.js";
import revoke from "./revoke.js";

const router = express.Router({ mergeParams: true });

router.post("/authorize", authorize); // local session required — mints a code
router.use("/token", token); // S2S only — HTTP-signature authenticated
router.post("/exchange", exchange); // consumer-side code exchange (unauthenticated)
router.get("/grants", grants); // local session required — list active grants
router.post("/revoke", revoke); // local session required — revoke one domain's grant

export default router;
