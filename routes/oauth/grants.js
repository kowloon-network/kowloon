// /routes/oauth/grants.js
// GET /oauth/grants — list the foreign domains this user has an active
// cross-server OAuth grant with (see methods/oauth/tokens.js#listActiveGrants).
import route from "../utils/route.js";
import { listActiveGrants } from "#methods/oauth/tokens.js";

export default route(
  async ({ user, set }) => {
    const grants = await listActiveGrants({ userId: user.id });
    set("grants", grants);
  },
  { allowUnauth: false, label: "OAUTH_GRANTS" }
);
