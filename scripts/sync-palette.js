// scripts/sync-palette.js
//
// The server's built-in "Kowloon Light/Dark" themes (routes/themes/index.js)
// are generated at runtime from config/palette.json -- a vendored copy of
// the shared design token file ../design/tokens/palette.json. The vendored
// copy exists because the server Docker image (Dockerfile.prod, stage 2) only
// ships the server's own directories, not the design package.
//
//   node scripts/sync-palette.js           re-copy from ../design
//   node scripts/sync-palette.js --check   exit 1 if the copy has drifted
//
// Override the source path with PALETTE_SRC=/path/to/palette.json.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(
  process.env.PALETTE_SRC || join(here, "..", "..", "design", "tokens", "palette.json")
);
const DEST = join(here, "..", "config", "palette.json");

if (!existsSync(SRC)) {
  console.error(`sync-palette: source not found: ${SRC}`);
  process.exit(2);
}

const src = readFileSync(SRC, "utf8");
JSON.parse(src); // refuse to vendor invalid JSON
const dest = existsSync(DEST) ? readFileSync(DEST, "utf8") : null;

if (process.argv.includes("--check")) {
  if (src !== dest) {
    console.error(
      `sync-palette: ${DEST} differs from ${SRC}. Run: node scripts/sync-palette.js`
    );
    process.exit(1);
  }
  console.log("sync-palette: config/palette.json is in sync");
  process.exit(0);
}

if (src === dest) {
  console.log("sync-palette: already in sync");
} else {
  writeFileSync(DEST, src);
  console.log(`sync-palette: copied ${SRC} -> ${DEST}`);
}
