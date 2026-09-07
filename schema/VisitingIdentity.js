// /schema/VisitingIdentity.js
// Consumer-side record of a foreign identity currently "visiting" this
// server (see routes/oauth/exchange.js, routes/outbox/post.js). Holds the
// real cross-server access/refresh tokens server-side only — the browser is
// only ever given an opaque sessionId embedded in a normal locally-signed
// session token, never these values directly. That way an XSS on this
// server's own frontend can't walk off with a token usable against the
// user's actual home server.
import mongoose from "mongoose";

const { Schema } = mongoose;

const VisitingIdentitySchema = new Schema(
  {
    sessionId:          { type: String, required: true, unique: true, index: true },
    userId:              { type: String, required: true }, // remote id, e.g. "@jzellis@kwln.social"
    homeDomain:          { type: String, required: true },
    accessToken:         { type: String, required: true },
    accessTokenExpiresAt:{ type: Date, required: true },
    refreshToken:        { type: String, default: null },
  },
  { timestamps: true }
);

export default mongoose.model("VisitingIdentity", VisitingIdentitySchema);
