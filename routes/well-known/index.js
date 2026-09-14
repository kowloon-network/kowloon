import express from "express";
import webfinger from "./webfinger.js";
import hostMeta from "./hostMeta.js";
import nodeinfo from "./nodeinfo.js";
import jwks from "./jwks.js";
const router = express.Router({ mergeParams: true });

// Mount well-known subroutes
router.use("/webfinger", webfinger);
router.use("/host-meta", hostMeta);
router.use("/nodeinfo", nodeinfo); // discovery doc — links to /nodeinfo/2.0
router.use("/jwks.json", jwks);
// The actual NodeInfo 2.0 document lives at /nodeinfo/2.0, outside
// .well-known entirely (the spec requires this) — see routes/nodeinfo/.

export default router;
