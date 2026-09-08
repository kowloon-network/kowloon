// Extracted from schema/{Circle,Bookmark,Group,Post,Page,Reply,Discovery,DiscoverySection}.js
// Dead-code audit finding: `.verifySignature()` instance method, defined on
// 8 content schemas, zero call sites anywhere in the repo. `signAs()` (the
// write-side counterpart, populating `this.signature` on save) is still
// live and unaffected — only the read-side verification was ever dead.
// Kept here for reference in case content-authenticity verification gets
// picked back up later.

// schema/Circle.js — CircleSchema.methods.verifySignature
CircleSchema.methods.verifySignature = async function () {
  const memberList = (this.members || []).map(m => m.id).sort().join(",");
  return verifyAs(this.actorId, `${this.id}|${this.name || ""}|${this.to}|${memberList}`, this.signature);
};

// schema/Bookmark.js — BookmarkSchema.methods.verifySignature
BookmarkSchema.methods.verifySignature = async function () {
  return verifyAs(this.actorId, `${this.id}|${this.href || this.target || ""}|${this.source?.content || ""}`, this.signature);
};

// schema/Group.js — GroupSchema.methods.verifySignature
GroupSchema.methods.verifySignature = async function () {
  return verifyAs(this.actorId, `${this.id}|${this.name || ""}|${this.to}`, this.signature);
};

// schema/Post.js — PostSchema.methods.verifySignature
PostSchema.methods.verifySignature = async function () {
  return verifyAs(this.actorId, `${this.id}|${this.source.content}`, this.signature);
};

// schema/Page.js — PageSchema.methods.verifySignature
PageSchema.methods.verifySignature = async function () {
  return verifyAs(this.actorId, `${this.id}|${this.createdAt}`, this.signature);
};

// schema/Reply.js — ReplySchema.methods.verifySignature (a different
// implementation from the others — direct crypto.verify against the
// actor's publicKey, not the shared verifyAs() helper)
ReplySchema.methods.verifySignature = async function () {
  let actor = await User.findOne({ id: this.actorId }); // Retrieve the activity actor
  let stringject = Buffer.from(JSON.stringify(this.id));
  return crypto.verify(
    "RSA-SHA256",
    stringject,
    actor.publicKey,
    this.signature
  );
};

// schema/Discovery.js — DiscoverySchema.methods.verifySignature
DiscoverySchema.methods.verifySignature = async function () {
  return verifyAs(this.actorId, `${this.id}|${this.ref}|${this.section}`, this.signature);
};

// schema/DiscoverySection.js — DiscoverySectionSchema.methods.verifySignature
DiscoverySectionSchema.methods.verifySignature = async function () {
  return verifyAs(this.actorId, `${this.id}|${this.name}|${this.to}`, this.signature);
};
