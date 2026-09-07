// routes/well-known/jwks.js
// Publishes this server's RSA public key as a JWK Set, so remote servers can
// verify JWTs this server issues (session tokens, OAuth access tokens) via
// jose's createRemoteJWKSet. kid matches methods/generate/token.js exactly:
// sha256(publicKey PEM) base64url — same key, same fingerprint, everywhere.
import express from "express";
import { createHash } from "crypto";
import { exportJWK, importSPKI } from "jose";
import getSettings from "#methods/settings/get.js";

const router = express.Router({ mergeParams: true });

router.get("/", async (req, res) => {
  try {
    const settings = await getSettings();
    const pem = (settings.publicKey || "").replace(/\\n/g, "\n").trim();
    if (!pem) return res.status(503).json({ error: "Server key not configured" });

    const kid = createHash("sha256").update(settings.publicKey).digest("base64url");
    const publicKey = await importSPKI(pem, "RS256");
    const jwk = await exportJWK(publicKey);

    res.set("Content-Type", "application/jwk-set+json; charset=utf-8");
    res.json({
      keys: [
        {
          ...jwk,
          kid,
          use: "sig",
          alg: "RS256",
        },
      ],
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to build JWKS" });
  }
});

export default router;
