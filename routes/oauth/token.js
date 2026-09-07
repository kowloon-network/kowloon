// /routes/oauth/token.js
// POST /oauth/token — server-to-server only. The requesting server proves its
// identity the same way every other S2S call already does: an HTTP Signature
// made with its own actor key (methods/federation/verifyHttpSignature.js) —
// no client_id/client_secret registration step, since Kowloon servers already
// mutually discover each other. "Client domain" is derived from the
// signature's keyId, never trusted from the request body.
import express from "express";
import Kowloon from "#kowloon";
import { OAuthCode, User } from "#schema";
import {
  mintAccessToken,
  issueRefreshToken,
  consumeRefreshToken,
} from "#methods/oauth/tokens.js";

const router = express.Router({ mergeParams: true });

function domainFromKeyId(keyId) {
  try {
    return new URL(keyId).hostname.toLowerCase();
  } catch {
    return null;
  }
}

router.post("/", async (req, res) => {
  let sig;
  try {
    sig = await Kowloon.federation.verifyHttpSignature(req, { verifyReplay: true });
  } catch (err) {
    return res.status(401).json({ error: "invalid_client", error_description: err.message });
  }
  if (!sig?.ok) {
    return res.status(401).json({ error: "invalid_client", error_description: sig?.error || "Signature verification failed" });
  }
  const clientDomain = domainFromKeyId(sig.keyId);
  if (!clientDomain) {
    return res.status(401).json({ error: "invalid_client" });
  }

  const grantType = req.body?.grant_type;

  try {
    if (grantType === "authorization_code") {
      const { code, redirect_uri: redirectUri } = req.body || {};
      if (!code || !redirectUri) {
        return res.status(400).json({ error: "invalid_request" });
      }

      const row = await OAuthCode.findOne({ code });
      if (!row || row.usedAt || row.expiresAt <= new Date()) {
        return res.status(400).json({ error: "invalid_grant" });
      }
      if (row.clientDomain !== clientDomain || row.redirectUri !== redirectUri) {
        return res.status(400).json({ error: "invalid_grant" });
      }
      row.usedAt = new Date();
      await row.save();

      const user = await User.findOne({ id: row.userId }).select("id username profile").lean();
      if (!user) return res.status(400).json({ error: "invalid_grant", error_description: "User not found" });

      const { token: access_token, expiresIn } = await mintAccessToken({ user, clientDomain });
      const refresh_token = await issueRefreshToken({ userId: user.id, clientDomain });

      return res.json({ access_token, refresh_token, token_type: "Bearer", expires_in: expiresIn });
    }

    if (grantType === "refresh_token") {
      const { refresh_token: rawRefresh } = req.body || {};
      const consumed = await consumeRefreshToken({ rawToken: rawRefresh, clientDomain });
      if (!consumed) return res.status(400).json({ error: "invalid_grant" });

      const user = await User.findOne({ id: consumed.userId }).select("id username profile").lean();
      if (!user) return res.status(400).json({ error: "invalid_grant", error_description: "User not found" });

      const { token: access_token, expiresIn } = await mintAccessToken({ user, clientDomain });
      const refresh_token = await issueRefreshToken({ userId: user.id, clientDomain });

      return res.json({ access_token, refresh_token, token_type: "Bearer", expires_in: expiresIn });
    }

    return res.status(400).json({ error: "unsupported_grant_type" });
  } catch (err) {
    return res.status(500).json({ error: "server_error", error_description: err.message });
  }
});

export default router;
