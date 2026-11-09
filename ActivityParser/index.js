// /ActivityParser/index.js (ESM)
// Builds the verb dispatch table: scans handlers/, auto-registers each
// subfolder's default-exported handler function under its directory name.
// The real write path (methods/activities/create.js, used by both /outbox
// and /inbox) calls `parser[activity.type]` directly after validating the
// envelope against ActivityParser/activity.schema.js -- this factory does
// not do any validation itself.
import { readdir, access } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { constants } from "fs";

import logger from "#methods/utils/logger.js";
import { reportError } from "#methods/utils/errorReporting.js";

// Memoized registry. Built once per process instead of re-reading the
// handlers directory on every activity. A build in which any handler failed
// to import is NOT cached, so the next call retries (same behaviour as before
// memoization -- this matters under Jest, where file:// dynamic imports fail;
// see tests/integrations/auth.change-password.test.js).
let registryPromise = null;
const reportedImportFailures = new Set();

async function buildRegistry() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const HANDLERS_DIR = join(__dirname, "handlers");

  const activity = async function () {};
  let hadImportError = false;

  const entries = await readdir(HANDLERS_DIR, { withFileTypes: true });

  await Promise.all(entries.filter(e => e.isDirectory()).map(async (dirent) => {
    const verb = dirent.name;

    // Skip utility directories (not handlers)
    if (verb === 'utils') return;

    const handlerPath = join(HANDLERS_DIR, verb, "index.js");
    try {
      await access(handlerPath, constants.R_OK);
    } catch {
      return; // no index.js in this directory -- not a handler
    }
    try {
      const modUrl = pathToFileURL(handlerPath).href;
      const mod = await import(modUrl);
      if (typeof mod.default === "function") {
        Object.defineProperty(activity, verb, { enumerable: true, value: mod.default });
      }
    } catch (err) {
      // A real import failure (e.g. syntax error) used to be swallowed and
      // surface only as "Unsupported activity type". Log + report it, once
      // per verb per process.
      hadImportError = true;
      if (!reportedImportFailures.has(verb)) {
        reportedImportFailures.add(verb);
        logger.error(`ActivityParser: failed to load handler "${verb}": ${err?.stack || err}`);
        reportError(err, { where: "ActivityParser handler import", verb });
      }
    }
  }));

  Object.defineProperty(activity, "verbs", {
    enumerable: true,
    value: entries.filter(e => e.isDirectory()).map(e => e.name),
  });

  return { activity, hadImportError };
}

export default async function ActivityParser() {
  if (!registryPromise) {
    registryPromise = buildRegistry().then(
      ({ activity, hadImportError }) => {
        if (hadImportError) registryPromise = null; // retry next time
        return activity;
      },
      (err) => {
        registryPromise = null;
        throw err;
      }
    );
  }
  return registryPromise;
}
