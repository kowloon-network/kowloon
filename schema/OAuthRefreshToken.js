// /schema/OAuthRefreshToken.js
// Long-lived refresh tokens for the cross-server OAuth flow, issued alongside
// a short-lived access token by routes/oauth/token.js. Stored hashed (never
// the raw value) — rotated on each use (old row revoked, new row inserted).
import mongoose from "mongoose";

const { Schema } = mongoose;

const OAuthRefreshTokenSchema = new Schema(
  {
    tokenHash:   { type: String, required: true, unique: true, index: true },
    userId:      { type: String, required: true },
    clientDomain:{ type: String, required: true },
    expiresAt:   { type: Date, required: true, expires: 0 }, // TTL index
    revokedAt:   { type: Date, default: null },
  },
  { timestamps: true }
);

export default mongoose.model("OAuthRefreshToken", OAuthRefreshTokenSchema);
