// schema/subschema/Attachment.js
// Post attachment — a persistent, resolved reference to a File. `fileId` is
// required: Kowloon only federates with other Kowloon servers, so every
// attachment (local or remote) always corresponds to a real File record
// living on some Kowloon server. `mediaType`/`kind`/`name`/`alt`/`width`/
// `height` are snapshotted at write time so reads never need a File join;
// serving URLs are always computed from `fileId` at read time instead of
// being persisted, since signed URLs for restricted files are short-lived.

import mongoose from "mongoose";
const { Schema } = mongoose;

const AttachmentSchema = new Schema(
  {
    fileId: { type: String, required: true },
    mediaType: { type: String, default: "" },
    kind: {
      type: String,
      enum: ["photo", "video", "audio", "file"],
      default: "file",
    },
    name: { type: String, default: "" },
    alt: { type: String, default: "" },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
  },
  { _id: false }
);

export default AttachmentSchema;
