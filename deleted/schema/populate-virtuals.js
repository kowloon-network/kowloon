// Extracted from schema/{Activity,Bookmark,Circle,Group,Post,Page}.js
// Dead-code audit finding: Mongoose virtual populate relations for "reacts"
// and "replies", never actually .populate()'d anywhere in the repo. Reacts/
// replies are served via denormalized reactCounts/reactPreview/replyCount
// fields instead (the current, actually-used design) — these are leftover
// from an earlier ref-based approach.

// schema/Activity.js — ActivitySchema.virtual("reacts")
ActivitySchema.virtual("reacts", {
  ref: "React",
  localField: "id",
  foreignField: "target",
});

// schema/Bookmark.js — BookmarkSchema.virtual("reacts")
BookmarkSchema.virtual("reacts", {
  ref: "React",
  localField: "id",
  foreignField: "target",
});

// schema/Circle.js — CircleSchema.virtual("reacts")
CircleSchema.virtual("reacts", {
  ref: "React",
  localField: "id",
  foreignField: "target",
});

// schema/Group.js — GroupSchema.virtual("reacts")
GroupSchema.virtual("reacts", {
  ref: "React",
  localField: "id",
  foreignField: "target",
});

// schema/Post.js — PostSchema.virtual("reacts") + PostSchema.virtual("replies")
PostSchema.virtual("reacts", {
  ref: "React",
  localField: "id",
  foreignField: "target",
});

PostSchema.virtual("replies", {
  ref: "Reply",
  localField: "id",
  foreignField: "target",
});

// schema/Page.js — PageSchema.virtual("reacts") + PageSchema.virtual("replies")
PageSchema.virtual("reacts", {
  ref: "React",
  localField: "id",
  foreignField: "target",
});

PageSchema.virtual("replies", {
  ref: "Reply",
  localField: "id",
  foreignField: "target",
});
