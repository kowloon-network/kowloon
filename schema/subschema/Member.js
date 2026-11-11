// schema/subschema/Member.js
// Circle/Group member — Actor fields plus federation freshness tracking.

import mongoose from "mongoose";
import ActorSchema from "./Actor.js";
const { Schema } = mongoose;

const MemberSchema = new Schema(
  {
    ...ActorSchema.obj,
    lastFetchedAt: { type: Date, default: null },
    // Optional note about why this member is in the circle -- e.g. the
    // reason someone is on the server's Blocked list. Visible to whoever can
    // see the circle.
    summary: { type: String, maxlength: 1000, default: undefined },
  },
  { _id: false, timestamps: true }
);

export default MemberSchema;
