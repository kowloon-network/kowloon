import express from "express";
import webfinger from "./webfinger.js";
import hostMeta from "./hostMeta.js";
import nodeinfo from "./nodeinfo.js";
import nodeinfo20 from "./nodeinfo20.js";
import jwks from "./jwks.js";
const router = express.Router({ mergeParams: true });

// Mount well-known subroutes
router.use("/webfinger", webfinger);
router.use("/host-meta", hostMeta);
router.use("/nodeinfo", nodeinfo);
router.use("/jwks.json", jwks);
// The /nodeinfo/2.0 document (not technically in .well-known, but linked from it)
router.use("/../nodeinfo/2.0", nodeinfo20); // relative mount so it's served at /nodeinfo/2.0

export default router;
