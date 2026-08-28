// /routes/auth/login.js
import route from "../utils/route.js";
import doLogin from "#methods/auth/login.js";
import logger from "#methods/utils/logger.js";

const DEV =
  process.env.NODE_ENV === "development" ||
  /^(1|true|yes)$/i.test(process.env.ROUTE_DEBUG || "");

const asStr = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const usernameFromActorId = (aid) => {
  const m = asStr(aid).match(/^@([^@]+)@[^@]+$/);
  return m ? m[1] : "";
};

export default route(
  async ({ body, set, setStatus }) => {
    const b = body && typeof body === "object" ? body : {};

    // Strict schema: only { username? , id? , password }
    const allowed = new Set(["username", "id", "password"]);
    const extras = Object.keys(b).filter((k) => !allowed.has(k));
    if (extras.length) {
      setStatus(400);
      set("error", `Unsupported fields: ${extras.join(", ")}`);
      return;
    }

    const username = asStr(b.username).trim();
    const id = asStr(b.id).trim(); // actor id like "@user@domain" OR server id like "@kwln.org"
    const password = asStr(b.password); // do NOT trim passwords

    if ((!username && !id) || !password) {
      setStatus(400);
      set("error", "username or id, and password are required");
      return;
    }

    let result = null;

    try {
      if (username) {
        // Primary: positional call expected by many legacy auth implementations
        if (DEV) console.log("AUTH LOGIN: trying username positional");
        result = await doLogin(username, password);
      } else {
        // id path
        if (DEV) console.log("AUTH LOGIN: trying actorId object");
        result = await doLogin({ actorId: id, password });

        // Fallback: if id was "@user@domain", try positional username
        if (result?.error) {
          const unameFromId = usernameFromActorId(id);
          if (unameFromId) {
            if (DEV)
              console.log(
                "AUTH LOGIN: fallback to username positional from id"
              );
            const alt = await doLogin(unameFromId, password);
            if (!alt?.error) result = alt;
          }
        }
      }
    } catch (err) {
      // If the auth method actually threw (not just returned {error}), treat
      // as 401 with the same clean, generic message every other auth-failure
      // path below already uses — the real error is logged server-side, not
      // handed to the client (this is what let a raw bcrypt "Illegal
      // arguments: string, undefined" internals leak straight into the login
      // form when doLogin() threw instead of returning {error}).
      logger.warn("AUTH LOGIN: doLogin threw", { error: err?.message });
      setStatus(401);
      set("error", "Invalid credentials");
      return;
    }

    if (!result || result.error) {
      if (result?.unverified) {
        setStatus(403);
        set("error", result.error);
        set("unverified", true);
        return;
      }
      // Clean 401 for any auth error ("Invalid credentials", "No password set", etc.)
      setStatus(401);
      set("error", result?.error || "Invalid credentials");
      return;
    }

    const token = result.token ?? result.accessToken ?? result.jwt;
    if (!token) {
      setStatus(500);
      set("error", "Login: missing token in response");
      return;
    }

    setStatus(200);
    set("token", token);
    if (result.user) set("user", result.user);
  },
  {
    allowUnauth: true, // login must not require req.user
    label: "AUTH LOGIN",
  }
);
