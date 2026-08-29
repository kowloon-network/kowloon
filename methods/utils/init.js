// /methods/utils/init.js
import mongoose from "mongoose";

import defaultSettings from "#config/defaultSettings.js";
import defaultUser from "#config/defaultUser.js";
import { Settings, User, Circle } from "#schema";
import toMember from "#methods/parse/toMember.js";
import { loadSettings } from "#methods/settings/cache.js";

function pickDbUri() {
  return (
    process.env.MONGODB_URI ||
    process.env.MONGO_URL ||
    process.env.DATABASE_URL ||
    process.env.MONGO_URI ||
    null
  );
}

// IMPORTANT: this file no longer creates an Express app or mounts routes.
// It ONLY connects to Mongo and seeds settings/admin.
export default async function init(Kowloon, ctx = {}) {
  // 1) Database (idempotent)
  try {
    if (mongoose.connection.readyState !== 1) {
      const uri = pickDbUri();
      if (!uri)
        throw new Error(
          "Missing DB URI (MONGODB_URI/MONGO_URL/DATABASE_URL/MONGO_URI)."
        );
      console.log("Kowloon: connecting to Mongo…");
      await mongoose.connect(uri, { maxPoolSize: 10 });
      console.log("Kowloon: Mongo connected.");
    } else {
      console.log("Kowloon: Mongo already connected.");
    }
    Kowloon.mongoose = mongoose;
    Kowloon.connection = mongoose.connection;
  } catch (e) {
    console.error("Kowloon DB connect failed:", e);
    process.exit(1);
  }

  // 2) Seed defaults, then load settings into memory
  if (!Kowloon.settings) Kowloon.settings = {};

  const isBadValue = (v) => {
    if (v === null || v === undefined) return true;
    if (typeof v === "string" && (v.includes("undefined") || v.includes("null"))) return true;
    return false;
  };

  const defaults = defaultSettings(ctx);
  for (const [name, def] of Object.entries(defaults)) {
    // Support both old flat format ({ name: value }) and new rich format ({ value, summary, ui, … })
    const isRich = def !== null && typeof def === "object" && "value" in def;
    const defValue = isRich ? def.value : def;
    const defMeta = isRich
      ? { summary: def.summary, to: def.to, canEdit: def.canEdit, ui: def.ui }
      : {};

    const exists = await Settings.findOne({ name }).lean();

    // For settings that must be plain strings (PEM keys), also overwrite if stored as non-string
    const mustBeString = ["publicKey", "privateKey"];
    const wrongType = mustBeString.includes(name) && typeof exists?.value !== "string";

    if (!exists) {
      await Settings.create({ name, value: defValue, ...defMeta });
      console.log("Created setting:", name);
    } else {
      // Always update metadata (ui, summary, to, canEdit) from the latest defaults
      const metaUpdate = {};
      if (defMeta.ui !== undefined) metaUpdate.ui = defMeta.ui;
      if (defMeta.summary !== undefined) metaUpdate.summary = defMeta.summary;
      if (defMeta.to !== undefined) metaUpdate.to = defMeta.to;
      if (defMeta.canEdit !== undefined) metaUpdate.canEdit = defMeta.canEdit;

      // Only update value if it's bad/corrupted
      if ((isBadValue(exists.value) || wrongType) && defValue && !isBadValue(defValue)) {
        metaUpdate.value = defValue;
        console.log("Updated setting value:", name);
      }

      if (Object.keys(metaUpdate).length > 0) {
        await Settings.updateOne({ name }, { $set: metaUpdate });
      }
    }
  }

  const adminCircleSetting = await Settings.findOne({ name: "adminCircle" }).lean();
  const adminCircleExists = adminCircleSetting?.value
    ? await Circle.exists({ id: adminCircleSetting.value })
    : false;

  if (!adminCircleExists) {
    const adminCircle = await Circle.create({
      name: `${ctx.SITE_TITLE || "Kowloon"} Admins`,
      to: "",
      canReact: "",
      canReply: "",
      actorId: `@${process.env.DOMAIN}`,
    });

    const modCircle = await Circle.create({
      name: `${ctx.SITE_TITLE || "Kowloon"} Moderators`,
      to: "",
      canReact: "",
      canReply: "",
      actorId: `@${process.env.DOMAIN}`,
    });

    await Settings.updateOne(
      { name: "adminCircle" },
      { value: adminCircle.id }
    );
    await Settings.updateOne({ name: "modCircle" }, { value: modCircle.id });
  }

  // Fix profile fields that were seeded with missing/undefined values
  {
    const profileSetting = await Settings.findOne({ name: "profile" }).lean();
    const updates = {};
    if (ctx.domain && profileSetting?.value?.urls?.some((u) => u.includes("undefined"))) {
      updates["value.urls"] = [`https://${ctx.domain}`];
    }
    if (!profileSetting?.value?.name && ctx.siteTitle) {
      updates["value.name"] = ctx.siteTitle;
    }
    // Heal the old seeded default icon path, which pointed at an asset that
    // was never actually shipped in the repo (og:image/twitter:image 404'd
    // on any server that hadn't yet uploaded a custom icon). Only replaces
    // this exact known-bad value — never touches an admin's own choice,
    // even another bare relative path.
    if (profileSetting?.value?.icon === "/images/icons/server.png") {
      updates["value.icon"] = "/logo.png";
    }
    if (Object.keys(updates).length) {
      await Settings.updateOne({ name: "profile" }, { $set: updates });
      console.log("Fixed profile setting:", Object.keys(updates).join(", "));
    }
  }

  // Load all settings into cache for fast access
  await loadSettings(Settings);

  // Also populate Kowloon.settings for backwards compatibility
  const settingsDocs = await Settings.find().lean();
  for (const s of settingsDocs) {
    Kowloon.settings[s.name] = s.value;
  }
  console.log("Kowloon settings loaded and cached");

  // 3) Create admin user from installer credentials (only if provided and no users exist)
  if (ctx.adminUsername && ctx.adminPassword) {
    const firstUser = await User.findOne({ username: ctx.adminUsername }).lean();
    if (!firstUser) {
      const adminUser = defaultUser(ctx);
      const created = await User.create(adminUser);

      await Circle.findOneAndUpdate(
        { id: Kowloon.settings.adminCircle },
        { memberCount: 1, $addToSet: { members: toMember(created) } }
      );
      await Circle.findOneAndUpdate(
        { id: Kowloon.settings.modCircle },
        { memberCount: 1, $addToSet: { members: toMember(created) } }
      );

      console.log(`Created admin user: ${ctx.adminUsername}`);
    }
  }

  return { connection: Kowloon.connection, settings: Kowloon.settings };
}
