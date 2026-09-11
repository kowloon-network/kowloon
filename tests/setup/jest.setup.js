import "dotenv/config";
import mongoose from "mongoose";
import http from "node:http";
import { buildApp } from "../helpers/app.js";
import init from "#methods/utils/init.js";

let server;

// Runs per test FILE, and must: Jest gives every test file its own module
// registry, so `mongoose` here is a distinct instance per file with its own
// connection state. This used to early-return on a global
// __TEST_SETUP_COMPLETE__ flag — but that flag is shared across files while
// the mongoose instance is not, so every file after the first skipped
// connecting and then failed with "Operation `x.findOne()` buffering timed
// out after 10000ms". Each file now gets its own connection, its own wiped
// database, and its own server, which also means suites can't pollute each
// other.
beforeAll(async () => {
  const baseUri = process.env.MONGO_URI || "mongodb://localhost:27017/kowloon";

  // One database per test FILE, named from the file itself. Every file wipes
  // its own database on entry, so a shared "kowloon_test" meant each suite
  // dropped the data the others were mid-way through using the moment more
  // than one ran. Per-file databases also let the suite run without
  // --runInBand, which matters because booting the app starts interval-driven
  // background workers (outbox push, poll) that keep querying after a file
  // finishes — in a shared process those stray queries land on a disconnected
  // mongoose and surface as "buffering timed out" against whichever suite is
  // unlucky enough to be running.
  const testPath = expect.getState?.()?.testPath || "shared";
  const slug =
    testPath
      .split("/")
      .pop()
      .replace(/\.test\.js$/, "")
      .replace(/[^a-zA-Z0-9]/g, "_")
      .slice(0, 40) || "shared";
  const uri = baseUri.replace(/\/(\w+)(\?|$)/, `/kowloon_test_${slug}$2`);

  // Only connect if not already connected
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(uri);
  }

  // Wipe the test DB before seeding
  await mongoose.connection.dropDatabase();

  // Bootstrap Settings (RSA keypair, adminCircle/modCircle, etc.) — without
  // this, JWT signing has no privateKey and every login 401s. buildApp() only
  // mounts routes; it never called init(), so the whole integration suite was
  // silently unable to authenticate (found 2026-08-10/11 while verifying the
  // block/mute + interaction-authorization fixes).
  await init({}, { domain: process.env.DOMAIN || "kwln.org" });

  // Minimal Settings for pre-save hooks
  const { User } = await import("#schema");

  // Create admin user for tests. Pass the PLAIN password — UserSchema's
  // pre("save") hook (schema/User.js) already hashes it on create via
  // isModified("password"); pre-hashing here double-hashed it, so bcrypt.
  // compare in the login route always failed ("Invalid credentials") no
  // matter what was typed. Same root-cause class as the RSA-key gap above:
  // this whole suite couldn't authenticate at all until both were fixed.
  await User.create({
    id: "@admin@kwln.org",
    username: "admin",
    email: "admin@kwln.org",
    password: "adminpass",
    profile: { name: "Admin" },
  });

  const app = await buildApp();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  global.__TEST_BASE_URL__ = `http://127.0.0.1:${server.address().port}`;
  global.__TEST_SETUP_COMPLETE__ = true;
  global.__TEST_SERVER__ = server;
}, 60000);

// Symmetrical with beforeAll: this file's own connection and server, closed
// at the end of this file. Safe now that setup is per-file — previously it
// tore down a connection the *other* suites were still relying on.
afterAll(async () => {
  // Drop this file's database so repeat runs start clean and the Mongo
  // instance doesn't accumulate one database per suite forever.
  try {
    await mongoose.connection.dropDatabase();
  } catch {
    // Already gone / never connected — nothing to clean up.
  }
  await mongoose.disconnect();
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});
