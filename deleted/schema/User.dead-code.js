// Extracted from schema/User.js
// Dead-code audit finding: these virtuals/instance methods have zero call
// sites anywhere in the repo. Real equivalents live elsewhere —
// methods/visibility/context.js's getViewerContext() reads user.circles.*
// directly instead of getMemberships/getBlocked/getMuted; real signing goes
// through methods/utils/signing.js (signAs/verifyAs) + jose-based JWTs, not
// these instance methods.

UserSchema.virtual("ownedCircles", {
  ref: "Circle",
  localField: "id", // user.id like "@alice@kwln.org"
  foreignField: "actorId", // circles the user owns (Following, Blocked, etc.)
  justOne: false,
});

UserSchema.virtual("memberCircles", {
  ref: "Circle",
  localField: "id",
  foreignField: "members.id", // circles where user is in members[]
  justOne: false,
});

UserSchema.methods.getMemberships = async function () {
  const circles = (
    await Circle.find({
      $or: [{ "members.id": this.id }, { actorId: this.id }],
    }).lean()
  ).map((c) => c.id);

  const groups = (
    await Group.find({
      $or: [
        { "members.id": this.id },
        { actorId: this.id },
        { admins: this.id },
      ],
    }).lean()
  ).map((g) => g.id);

  return [...circles, ...groups];
};

UserSchema.methods.getBlocked = async function () {
  return (await Circle.findOne({ id: this.circles?.blocked })).members.map(
    (m) => m.id,
  );
};

UserSchema.methods.getMuted = async function () {
  return (await Circle.findOne({ id: this.circles?.muted })).members.map(
    (m) => m.id,
  );
};

UserSchema.methods.sign = function (data) {
  return signData(this.privateKey, data);
};

UserSchema.methods.verify = function (data, signature) {
  return verifyData(this.publicKey, data, signature);
};

UserSchema.methods.createUserSignature = function (timestamp) {
  const token = this.id + ":" + timestamp.toString();
  const hash = crypto.createHash("sha256").update(token).digest();
  const signature = crypto
    .sign("sha256", hash, this.privateKey)
    .toString("base64");
  return { id: this.id, timestamp, signature };
};

UserSchema.methods.verifyUserSignature = function (timestamp, signature) {
  const token = this.id + ":" + timestamp;
  const hash = crypto.createHash("sha256").update(token).digest();
  const isValid = crypto.verify(
    "sha256",
    hash,
    this.publicKey,
    Buffer.from(signature, "base64"),
  );
  return isValid ? isValid : new Error("User cannot be authenticated");
};
