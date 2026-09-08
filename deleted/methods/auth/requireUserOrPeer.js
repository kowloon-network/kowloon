// #methods/auth/requireUserOrPeer.js
import requirePeer from "./requirePeer.js";
import requireUser from "./requireUser.js";

export default async function requireUserOrPeer(
  req,
  { expectedAudience } = {}
) {
  try {
    const user = await requireUser(req, { expectedAudience });
    return { user, peer: null };
  } catch {
    const peer = await requirePeer(req);
    return { user: null, peer };
  }
}
