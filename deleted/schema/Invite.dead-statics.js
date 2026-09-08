// Extracted from schema/Invite.js
// Dead-code audit finding: InviteSchema.statics.findByCode() is unused —
// every real call site does Invite.findOne({ code }) directly instead.

InviteSchema.statics.findByCode = async function (code) {
  const invite = await this.findOne({
    code,
    active: true,
    deletedAt: null,
  });

  if (!invite) return null;
  if (!invite.isValid) return null;

  return invite;
};
