// /routes/oauth/authorize.js
// POST /oauth/authorize — requires an existing local session (the frontend's
// consent screen calls this after the user clicks Allow). Mints a short-lived,
// single-use authorization code and hands back the URL the frontend should
// navigate to next. Deliberately a JSON POST, not a raw redirecting GET — the
// frontend (a normal SPA route) owns navigation, consistent with the rest of
// this app's route()-wrapped JSON API.
import route from "../utils/route.js";
import crypto from "crypto";
import { OAuthCode } from "#schema";

const CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export default route(async ({ body, user, set, setStatus }) => {
  const { clientDomain, redirectUri, state } = body || {};

  if (!clientDomain || !redirectUri) {
    setStatus(400);
    set("error", "Missing clientDomain or redirectUri");
    return;
  }

  let parsedRedirect;
  try {
    parsedRedirect = new URL(redirectUri);
  } catch {
    setStatus(400);
    set("error", "Invalid redirectUri");
    return;
  }

  // Open-redirect guard: the redirect target must actually belong to the
  // domain requesting the grant.
  if (parsedRedirect.hostname.toLowerCase() !== String(clientDomain).toLowerCase()) {
    setStatus(400);
    set("error", "redirectUri must be on clientDomain");
    return;
  }
  if (parsedRedirect.protocol !== "https:" && process.env.NODE_ENV === "production") {
    setStatus(400);
    set("error", "redirectUri must be https");
    return;
  }

  const code = crypto.randomBytes(24).toString("hex");
  await OAuthCode.create({
    code,
    userId: user.id,
    clientDomain: String(clientDomain).toLowerCase(),
    redirectUri,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });

  const sep = redirectUri.includes("?") ? "&" : "?";
  const dest = `${redirectUri}${sep}code=${encodeURIComponent(code)}${
    state ? `&state=${encodeURIComponent(state)}` : ""
  }`;

  setStatus(200);
  set("redirectUri", dest);
});
