// /schema/OAuthCode.js
// Short-lived, single-use authorization codes for the cross-server OAuth
// flow (see routes/oauth/authorize.js, routes/oauth/token.js). Same TTL
// pattern as SignatureNonce.js — Mongo auto-deletes expired rows.
import mongoose from "mongoose";

const { Schema } = mongoose;

const OAuthCodeSchema = new Schema(
  {
    code:        { type: String, required: true, unique: true, index: true },
    userId:      { type: String, required: true }, // the local user who consented
    clientDomain:{ type: String, required: true }, // requesting server's domain
    redirectUri: { type: String, required: true },
    usedAt:      { type: Date, default: null }, // set on exchange; guards single-use
    expiresAt:   { type: Date, required: true, expires: 0 }, // TTL index
  },
  { timestamps: true }
);

export default mongoose.model("OAuthCode", OAuthCodeSchema);
