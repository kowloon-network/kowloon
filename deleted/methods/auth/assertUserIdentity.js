// #methods/auth/assertUserIdentity.js
import requirePeer from "./requirePeer.js";
import verifyUserJwt from "./verifyUserJwt.js"; //  [oai_citation:3‡verifyUserJwt.js](file-service://file-8gZMHNcxmxqGfksDDkbJPc)

/**
 * Ensure the caller proved the identity of claimedUserId.
 * - If the user is local (same domain as process.env.DOMAIN): require a valid local user JWT.
 * - If the user is remote: require a valid peer via HMAC + a valid user JWT issued by that remote.
 */
export default async function assertUserIdentity(req, claimedUserId) {
  if (typeof claimedUserId !== "string" || !claimedUserId.includes("@")) {
    const e = new Error("Invalid claimed user id");
    e.status = 400;
    throw e;
  }

  const domain = claimedUserId.split("@").pop();
  const localDomain = (process.env.DOMAIN || "").toLowerCase();
  const expectedAudience = `https://${localDomain}`;
  const expectedIssuer = `https://${domain}`;

  const authz = req.header("Authorization") || "";
  const token = authz.startsWith("Bearer ") ? authz.slice(7).trim() : null;
  if (!token) {
    const e = new Error("Missing user Bearer token");
    e.status = 401;
    throw e;
  }

  if (domain.toLowerCase() === localDomain) {
    // local user → just verify the token against local key
    const payload = await verifyUserJwt(token, {
      expectedIssuer,
      expectedAudience,
    });
    if (payload?.user?.id !== claimedUserId) {
      const e = new Error("User token subject mismatch");
      e.status = 401;
      throw e;
    }
    return { user: payload.user, peer: null };
  }

  // remote user → require a peer AND a valid remote-issued token
  const peer = await requirePeer(req);
  if (peer.clientId !== domain) {
    const e = new Error("Peer is not authoritative for this user");
    e.status = 401;
    throw e;
  }

  const payload = await verifyUserJwt(token, {
    expectedIssuer,
    expectedAudience,
  });
  if (payload?.user?.id !== claimedUserId) {
    const e = new Error("Remote user token subject mismatch");
    e.status = 401;
    throw e;
  }

  return { user: payload.user, peer };
}
