// /routes/oauth/exchange.js
// POST /oauth/exchange — consumer side. Called by OUR OWN frontend, same
// origin, right after the browser lands back from the home server's consent
// redirect with a `code`. No local session exists yet at this point, so this
// route is intentionally unauthenticated (allowUnauth). Everything that talks
// to the foreign home server happens here, server-to-server — the browser
// never sees the code exchanged for a home-server access token, only the
// locally-issued visiting session token this route hands back at the end.
import { safeFetch } from "#methods/utils/safeUrl.js";
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

    // SECURITY (2026-11-09): homeDomain must be a plain foreign hostname. It
    // is interpolated into the token URL and is the issuer we verify against,
    // so it can never be our own domain (a "visiting" login as a local user
    // is meaningless and was the root of a forged-admin-login attack).
    const home = String(homeDomain).trim().toLowerCase();
    if (
      !/^[a-z0-9.-]+(:\d+)?$/.test(home) ||
      home === String(ownDomain).toLowerCase()
    ) {
      setStatus(400);
      set("error", "Invalid homeDomain");
      return;
    }
    const redirectUri = `https://${ownDomain}/oauth/callback`;
    const tokenUrl = `https://${home}/oauth/token`;

    const payload = { grant_type: "authorization_code", code, redirect_uri: redirectUri };
    const bodyStr = JSON.stringify(payload);
    const headers = { "content-type": "application/json" };
    await signHttpRequest({ method: "POST", url: tokenUrl, headers, body: bodyStr });

    let tokenRes;
    try {
      tokenRes = await safeFetch(tokenUrl, { method: "POST", headers, body: bodyStr, timeout: 15000 });
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
        expectedIssuer: `https://${home}`,
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

    // SECURITY (2026-11-09): the token was verified against homeDomain's OWN
    // keys, so it only proves anything about accounts ON homeDomain. Without
    // this check, evil.com could sign a token claiming to be
    // @admin@<our-domain> and be handed a session for our admin.
    const idDomain = String(remoteUser.id).slice(String(remoteUser.id).lastIndexOf("@") + 1).toLowerCase();
    if (idDomain !== home) {
      setStatus(400);
      set("error", "Access token names an account that isn't on homeDomain");
      return;
    }

    const sessionId = crypto.randomUUID();
    await VisitingIdentity.create({
      sessionId,
      userId: remoteUser.id,
      homeDomain: home,
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
