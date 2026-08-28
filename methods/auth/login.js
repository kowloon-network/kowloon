// /methods/auth/login.js
import { User } from "#schema";
import generateToken from "#methods/generate/token.js";
import { getSetting } from "#methods/settings/cache.js";
import isServerAdmin from "#methods/auth/isServerAdmin.js";

const S = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));

export default async function login(input, maybePassword = "") {
  // Accept either style:
  //   login({ username, actorId: id, password })
  //   login(username, password)
  const hasObj = input && typeof input === "object";
  const username = hasObj ? S(input.username).trim() : S(input).trim();
  const actorId = hasObj ? S(input.actorId || input.id).trim() : "";
  const password = hasObj ? S(input.password) : S(maybePassword); // do NOT trim pw

  if ((!username && !actorId) || !password) {
    return { error: "Missing parameter" };
  }

  // Look up by actor id (id) OR username. Username is only unique PER SERVER
  // (schema/User.js's compound {username, originDomain} index — two real
  // users on two different servers can legitimately share a bare username),
  // so a bare-username lookup must be scoped to local accounts. Without this,
  // it could non-deterministically match a federated shadow of a remote
  // user with the same username (a cached actor record with no local
  // password), throwing a raw bcrypt "Illegal arguments: string, undefined"
  // when comparing against its undefined password field instead of a clean
  // "Invalid credentials".
  const query = actorId ? { id: actorId } : { username, originDomain: getSetting("domain") };
  const userDoc = await User.findOne(query)
    .select(
      "id username type profile prefs publicKey password lastLogin circles emailVerified"
    )
    .lean(false); // need a Mongoose doc to call instance methods

  if (!userDoc) return { error: "Invalid credentials" };

  const ok = await userDoc.verifyPassword(password); // bcrypt compare via schema method
  if (!ok) return { error: "Invalid credentials" };

  if (getSetting("requireEmailVerification") === true && !userDoc.emailVerified) {
    return { error: "Please verify your email address before logging in.", unverified: true };
  }

  // (optional) best-effort lastLogin update
  try {
    await User.updateOne(
      { _id: userDoc._id },
      { $set: { lastLogin: new Date() } }
    );
  } catch {}

  const token = await generateToken(userDoc.id);

  // Safe user payload
  const uo = userDoc.toObject({ depopulate: true });
  const user = {
    id: uo.id,
    username: uo.username,
    type: uo.type,
    profile: uo.profile,
    prefs: uo.prefs,
    publicKey: uo.publicKey,
    following: uo.circles?.following,
    allFollowing: uo.circles?.allFollowing,
    blocked: uo.circles?.blocked,
    muted: uo.circles?.muted,
    groups: uo.circles?.groups,
    isServerAdmin: !!(await isServerAdmin(uo.id)),
  };

  return { user, token };
}
