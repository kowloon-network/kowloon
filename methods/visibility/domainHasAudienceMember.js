// methods/visibility/domainHasAudienceMember.js
// Authorizes a cross-server (S2S) request for restricted content by domain,
// not by individual user identity: does the audience this content is
// restricted to have ANY member on the requesting peer's domain? Used by
// routes/files/serve.js to decide whether a signed peer-server request may
// fetch restricted file bytes (see methods/files/hydrateRemoteFile.js and
// issue #57) — the peer's own local canAccess() then gates which of ITS
// users can see the bytes it caches, same as any local file.

import { Circle, Group } from "#schema";
import kowloonId from "#methods/parse/kowloonId.js";
import { isPublicVisibility } from "#methods/files/signedUrl.js";

function circleHasMemberOnDomain(members, domain) {
  const target = String(domain || "").toLowerCase();
  return (members ?? []).some((m) => {
    const parsed = kowloonId(m?.id);
    return parsed?.domain && parsed.domain.toLowerCase() === target;
  });
}

export async function domainHasAudienceMember(to, domain) {
  if (!to || !domain) return false;
  if (isPublicVisibility(to)) return true;

  // Bare "@domain" (server-only) — intentionally never leaves that one
  // server, so no other peer has standing regardless of domain match.
  if (/^@[^@]+$/.test(to)) return false;

  // A specific user id — no peer server has standing for a single-user
  // grant; that user authenticates locally via JWT, not S2S.
  if (to.startsWith("@")) return false;

  if (to.startsWith("circle:")) {
    const circle = await Circle.findOne({ id: to }).select("members.id").lean();
    return circleHasMemberOnDomain(circle?.members, domain);
  }

  if (to.startsWith("group:")) {
    const group = await Group.findOne({ id: to }).select("circles.members").lean();
    const membersCircleId = group?.circles?.members;
    if (!membersCircleId) return false;
    const circle = await Circle.findOne({ id: membersCircleId }).select("members.id").lean();
    return circleHasMemberOnDomain(circle?.members, domain);
  }

  return false;
}

export default domainHasAudienceMember;
