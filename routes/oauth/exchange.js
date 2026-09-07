// /routes/oauth/exchange.js
// POST /oauth/exchange — consumer side. Called by OUR OWN frontend, same
// origin, right after the browser lands back from the home server's consent
// redirect with a `code`. No local session exists yet at this point, so this
// route is intentionally unauthenticated (allowUnauth). Everything that talks
// to the foreign home server happens here, server-to-server — the browser
// never sees the code exchanged for a home-server access token, only the
// locally-issued visiting session token this route hands back at the end.
import route from "../utils/route.js";
import crypto from "crypto";
import getSettings from "#methods/settings/get.js";
import signHttpRequest from "#methods/federation/signHttpRequest.js";
import verifyUserJwt from "#methods/auth/verifyUserJwt.js";
import { VisitingIdentity } from "#schema";
import { mintVisitingSessionToken } from "#methods/oauth/tokens.js";

export default route(
  async ({ body, set, setStatus }) => {
    const { code, homeDomain } = body || {};
    if (!code || !homeDomain) {
      setStatus(400);
      set("error", "Missing code or homeDomain");
      return;
    }

    const settings = await getSettings();
    const ownDomain = settings.domain;
    const redirectUri = `https://${ownDomain}/oauth/callback`;
    const tokenUrl = `https://${homeDomain}/oauth/token`;

    const payload = { grant_type: "authorization_code", code, redirect_uri: redirectUri };
    const bodyStr = JSON.stringify(payload);
    const headers = { "content-type": "application/json" };
    await signHttpRequest({ method: "POST", url: tokenUrl, headers, body: bodyStr });

    let tokenRes;
    try {
      tokenRes = await fetch(tokenUrl, { method: "POST", headers, body: bodyStr });
    } catch {
      setStatus(502);
      set("error", `Could not reach ${homeDomain}`);
      return;
    }

    if (!tokenRes.ok) {
      setStatus(400);
      set("error", "Token exchange failed");
      return;
    }

    const tokenData = await tokenRes.json().catch(() => null);
    const { access_token, refresh_token, expires_in } = tokenData || {};
    if (!access_token) {
      setStatus(400);
      set("error", "No access token returned");
      return;
    }

    let claims;
    try {
      claims = await verifyUserJwt(access_token, {
        expectedIssuer: `https://${homeDomain}`,
        expectedAudience: `https://${ownDomain}`,
      });
    } catch (err) {
      setStatus(400);
      set("error", `Could not verify access token: ${err.message}`);
      return;
    }

    const remoteUser = claims.user;
    if (!remoteUser?.id || claims.sub !== remoteUser.id) {
      setStatus(400);
      set("error", "Access token subject mismatch");
      return;
    }

    const sessionId = crypto.randomUUID();
    await VisitingIdentity.create({
      sessionId,
      userId: remoteUser.id,
      homeDomain,
      accessToken: access_token,
      accessTokenExpiresAt: new Date(Date.now() + (expires_in || 3600) * 1000),
      refreshToken: refresh_token || null,
    });

    const sessionToken = await mintVisitingSessionToken({ sessionId, user: remoteUser });

    setStatus(200);
    set("token", sessionToken);
    set("user", remoteUser);
  },
  { allowUnauth: true, label: "OAUTH_EXCHANGE" }
);
