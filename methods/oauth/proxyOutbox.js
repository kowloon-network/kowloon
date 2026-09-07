// #methods/oauth/proxyOutbox.js
// When a visiting identity (see routes/oauth/exchange.js) posts to this
// server's /outbox, the write must happen authoritatively on their actual
// home server — not here — so it reuses that server's normal local-authority
// pipeline, and that server's existing federation-out logic
// (ActivityParser/handlers/Reply/index.js's getFederationTargets, etc.)
// delivers the result back to us exactly like any other remote interaction.
// This forwards the activity server-to-server using the stored OAuth access
// token, transparently refreshing it first via the refresh token if expired.
import { VisitingIdentity } from "#schema";
import signHttpRequest from "#methods/federation/signHttpRequest.js";

async function refreshAccessToken(identity) {
  const tokenUrl = `https://${identity.homeDomain}/oauth/token`;
  const payload = { grant_type: "refresh_token", refresh_token: identity.refreshToken };
  const bodyStr = JSON.stringify(payload);
  const headers = { "content-type": "application/json" };
  await signHttpRequest({ method: "POST", url: tokenUrl, headers, body: bodyStr });

  const res = await fetch(tokenUrl, { method: "POST", headers, body: bodyStr });
  if (!res.ok) {
    throw new Error("Failed to refresh visiting session (home server rejected refresh token)");
  }
  const data = await res.json();
  identity.accessToken = data.access_token;
  identity.accessTokenExpiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000);
  identity.refreshToken = data.refresh_token || identity.refreshToken;
  await identity.save();
  return identity;
}

export default async function proxyOutbox({ sessionId, activity }) {
  let identity = await VisitingIdentity.findOne({ sessionId });
  if (!identity) {
    return { status: 401, body: { error: "Visiting session not found or expired" } };
  }

  // 5s buffer so we don't hand a token that's about to expire mid-flight.
  if (identity.accessTokenExpiresAt <= new Date(Date.now() + 5000)) {
    try {
      identity = await refreshAccessToken(identity);
    } catch (err) {
      return { status: 401, body: { error: err.message } };
    }
  }

  const url = `https://${identity.homeDomain}/outbox`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${identity.accessToken}`,
      },
      body: JSON.stringify(activity),
    });
  } catch {
    return { status: 502, body: { error: `Could not reach ${identity.homeDomain}` } };
  }

  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}
