// routes/themes/index.js
// Theme management — list/get are public; create/update/delete require admin.
// Built-in themes (isBuiltIn: true) cannot be deleted or have isBuiltIn toggled off.
// Bootstraps the three built-in themes on first startup if they don't exist.

import express from "express";
import { readFileSync } from "fs";
import route from "../utils/route.js";
import { Theme, Settings } from "#schema";
import isServerAdmin from "#methods/auth/isServerAdmin.js";
import { getSetting } from "#methods/settings/cache.js";

const router = express.Router({ mergeParams: true });

// ── Built-in theme data ────────────────────────────────────────────────────────


// Colors are generated from config/palette.json, a vendored copy of the
// shared design tokens (../design/tokens/palette.json -- the single source of
// truth for web + mobile). The server image doesn't ship ../design, hence the
// copy; `node scripts/sync-palette.js` refreshes it and `--check` fails if it
// has drifted. These used to be a hand-copied literal that went stale (accent
// stayed #c0394a after the palette moved to vermillion).
//
// Shape matches what the web frontend's injectTheme() consumes
// (frontend/src/features/theme/themeSlice.js): `colors` -> --color-<key>,
// `postColors` -> --post-color-<key>. header/header-content are omitted on
// purpose (the signature header stays constant across themes) and post-*
// tokens move to postColors.
const PALETTE = JSON.parse(
  readFileSync(new URL("../../config/palette.json", import.meta.url), "utf8")
);

function themeColorsFromPalette(mode) {
  const tokens = PALETTE[mode] || {};
  const colors = {};
  const postColors = {};
  for (const [key, value] of Object.entries(tokens)) {
    if (key.startsWith("post-")) postColors[key.slice(5)] = value;
    else if (key !== "header" && key !== "header-content") colors[key] = value;
  }
  return { colors, postColors };
}

const BUILT_IN_THEMES = [
  {
    id: "system",
    name: "System",
    description: "Follows your OS light/dark preference automatically.",
    author: "system",
    colorScheme: "system",
    isBuiltIn: true,
    colors: null,
    postColors: null,
  },
  {
    id: "kowloon-light",
    name: "Kowloon Light",
    description: "Warm cream paper tones. Blue Note Records by daylight.",
    author: "system",
    colorScheme: "light",
    isBuiltIn: true,
    ...themeColorsFromPalette("light"),
  },
  {
    id: "kowloon-dark",
    name: "Kowloon Dark",
    description: "Dark navy-charcoal. Blue Note Records by night.",
    author: "system",
    colorScheme: "dark",
    isBuiltIn: true,
    ...themeColorsFromPalette("dark"),
  },
];

// Seed built-in themes on every startup, overwriting existing docs.
//
// This MUST be $set, not $setOnInsert: built-in themes can't be edited via
// the API (isBuiltIn is checked on every write route below), so BUILT_IN_THEMES
// above is their only source of truth, and any server that already had these
// docs from before a code change would otherwise keep serving stale content
// forever. That already happened once — kowloon-light/kowloon-dark shipped
// with hand-tuned OKLCH colors, then a1ea9fd9 (2026-08-10) switched them to a
// literal hex copy of palette.json to stop them drifting from the app, but
// every server seeded before that commit silently kept the old OKLCH values
// (setOnInsert never touches an existing doc), invisibly undoing the fix.
async function seedBuiltInThemes() {
  try {
    for (const themeData of BUILT_IN_THEMES) {
      await Theme.updateOne(
        { id: themeData.id },
        { $set: themeData },
        { upsert: true }
      );
    }
    // Self-heal: remove any previously-seeded system theme that's no longer in
    // BUILT_IN_THEMES (e.g. the old decorative gallery — Solarized, Dracula,
    // Nord, etc. — retired 2026-08-10 in favor of matching the app exactly:
    // System/Light/Dark only). Scoped to author "system" so admin-created
    // custom themes are never touched.
    await Theme.deleteMany({
      author: "system",
      id: { $nin: BUILT_IN_THEMES.map((t) => t.id) },
    });
    // Ensure a defaultTheme setting exists
    await Settings.updateOne(
      { name: "defaultTheme" },
      {
        $setOnInsert: {
          name: "defaultTheme",
          value: "system",
          summary: "The default theme for the server. Users can override this in their profile.",
          to: "@public",
          canEdit: "@admin",
          ui: {
            type: "select",
            label: "Default Theme",
            group: "appearance",
            order: 10,
          },
        },
      },
      { upsert: true }
    );
  } catch (err) {
    console.error("themes: seed error:", err.message);
  }
}

// Run seed at module load (non-blocking)
seedBuiltInThemes().then(() => console.log("themes: built-in themes seeded"));

// ── Helpers ───────────────────────────────────────────────────────────────────

function sanitize(doc) {
  const t = doc.toObject ? doc.toObject() : doc;
  return {
    id: t.id,
    name: t.name,
    description: t.description ?? "",
    author: t.author,
    version: t.version,
    colorScheme: t.colorScheme,
    isBuiltIn: t.isBuiltIn ?? false,
    colors: t.colors ?? null,
    postColors: t.postColors ?? null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

// ── GET /themes ───────────────────────────────────────────────────────────────

router.get(
  "/",
  route(async ({ set }) => {
    const [themes, defaultSetting] = await Promise.all([
      Theme.find().sort({ isBuiltIn: -1, createdAt: 1 }).lean(),
      Settings.findOne({ name: "defaultTheme" }).lean(),
    ]);
    set("themes", themes.map(sanitize));
    set("defaultThemeId", defaultSetting?.value ?? "system");
  })
);

// ── GET /themes/:id ───────────────────────────────────────────────────────────

router.get(
  "/:id",
  route(async ({ params, set, setStatus }) => {
    const theme = await Theme.findOne({ id: params.id }).lean();
    if (!theme) {
      setStatus(404);
      set("error", "Theme not found");
      return;
    }
    set("theme", sanitize(theme));
  })
);

// ── POST /themes — create (admin only) ───────────────────────────────────────

router.post(
  "/",
  route(async ({ body, user, set, setStatus }) => {
    if (!user?.id) { setStatus(401); set("error", "Authentication required"); return; }
    if (!(await isServerAdmin(user.id))) { setStatus(403); set("error", "Admin only"); return; }

    const { id, name, description, colorScheme, colors, postColors } = body;
    if (!id || !name || !colorScheme) {
      setStatus(400);
      set("error", "id, name, and colorScheme are required");
      return;
    }
    if (await Theme.exists({ id })) {
      setStatus(409);
      set("error", "A theme with that id already exists");
      return;
    }

    const theme = await Theme.create({
      id,
      name,
      description: description ?? "",
      author: user.id,
      colorScheme,
      isBuiltIn: false,
      colors: colors ?? null,
      postColors: postColors ?? null,
    });

    setStatus(201);
    set("theme", sanitize(theme));
  })
);

// ── PUT /themes/:id — update (admin only, not isBuiltIn) ─────────────────────

router.put(
  "/:id",
  route(async ({ params, body, user, set, setStatus }) => {
    if (!user?.id) { setStatus(401); set("error", "Authentication required"); return; }
    if (!(await isServerAdmin(user.id))) { setStatus(403); set("error", "Admin only"); return; }

    const theme = await Theme.findOne({ id: params.id });
    if (!theme) { setStatus(404); set("error", "Theme not found"); return; }
    if (theme.isBuiltIn) { setStatus(403); set("error", "Built-in themes cannot be modified"); return; }

    const allowed = ["name", "description", "colorScheme", "colors", "postColors"];
    for (const key of allowed) {
      if (body[key] !== undefined) theme[key] = body[key];
    }
    await theme.save();
    set("theme", sanitize(theme));
  })
);

// ── DELETE /themes/:id — delete (admin only, not isBuiltIn) ──────────────────

router.delete(
  "/:id",
  route(async ({ params, user, set, setStatus }) => {
    if (!user?.id) { setStatus(401); set("error", "Authentication required"); return; }
    if (!(await isServerAdmin(user.id))) { setStatus(403); set("error", "Admin only"); return; }

    const theme = await Theme.findOne({ id: params.id });
    if (!theme) { setStatus(404); set("error", "Theme not found"); return; }
    if (theme.isBuiltIn) { setStatus(403); set("error", "Built-in themes cannot be deleted"); return; }

    await Theme.deleteOne({ id: params.id });
    set("ok", true);
  })
);

// ── PATCH /themes/default — set server default (admin only) ──────────────────

router.patch(
  "/default",
  route(async ({ body, user, set, setStatus }) => {
    if (!user?.id) { setStatus(401); set("error", "Authentication required"); return; }
    if (!(await isServerAdmin(user.id))) { setStatus(403); set("error", "Admin only"); return; }

    const { themeId } = body;
    if (!themeId) { setStatus(400); set("error", "themeId is required"); return; }
    if (!(await Theme.exists({ id: themeId }))) {
      setStatus(404);
      set("error", "Theme not found");
      return;
    }

    await Settings.updateOne(
      { name: "defaultTheme" },
      { $set: { value: themeId } },
      { upsert: true }
    );
    set("defaultThemeId", themeId);
  })
);

export default router;
