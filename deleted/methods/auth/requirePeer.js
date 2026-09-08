// #methods/auth/requirePeer.js
import verifyS2S from "./verifyS2S.js";

export default async function requirePeer(req) {
  const peer = await verifyS2S(req);
  if (!peer) {
    const e = new Error("Unauthorized peer");
    e.status = 401;
    throw e;
  }
  return peer; // { clientId }
}
