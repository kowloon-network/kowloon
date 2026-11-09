import getSettings from "#methods/settings/get.js";
import { Circle, User } from "#schema";
import { SignJWT, importPKCS8 } from "jose";
import { createHash } from "crypto";

export default async function (actorId) {
  const settings = await getSettings();
  const user = await User.findOne({ id: actorId }).select(
    "id username profile circles lastLogin"
  );

  const blockedCircle = await Circle.findOne({ id: user.circles?.blocked }).select("members");
  let blocked = blockedCircle?.members?.map((m) => m.id) || [];

  const mutedCircle = await Circle.findOne({ id: user.circles?.muted }).select("members");
  let muted = mutedCircle?.members?.map((m) => m.id) || [];

  // Convert to plain object so jose's structuredClone doesn't choke on Mongoose subdocs
  const u = user.toObject({ depopulate: true });

  const pk = await importPKCS8(
    settings.privateKey.replace(/\\n/g, "\n").trim(),
    "RS256"
  );
  const kid = createHash("sha256")
    .update(settings.publicKey)
    .digest("base64url");
  let token = await new SignJWT({
    user: {
      id: u.id,
      username: u.username,
      profile: u.profile,
      muted,
      blocked,
      following: u.circles?.following,
      lastLogin: u.lastLogin,
      feedRefreshedAt: u.feedRefreshedAt,
    },
    loggedIn: u.lastLogin,
  })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(`https://${settings.domain}`)
    // iat is what User.tokensValidAfter is compared against (route.js).
    .setIssuedAt()
    .sign(pk);

  return token;
}
