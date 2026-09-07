// /routes/oauth/revoke.js
// POST /oauth/revoke — user-initiated early cutoff of a cross-server OAuth
// grant, same effect the Add handler triggers automatically when a domain
// gets blocked (see ActivityParser/handlers/Add/index.js).
import route from "../utils/route.js";
import { revokeGrantsForDomain } from "#methods/oauth/tokens.js";

export default route(
  async ({ body, user, set, setStatus }) => {
    const { clientDomain } = body || {};
    if (!clientDomain) {
      setStatus(400);
      set("error", "Missing clientDomain");
      return;
    }
    const count = await revokeGrantsForDomain({ userId: user.id, clientDomain });
    set("revoked", count > 0);
  },
  { label: "OAUTH_REVOKE" }
);
