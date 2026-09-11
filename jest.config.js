// jest.config.mjs
export default {
  testEnvironment: "node",
  transform: {},
  // tests/setup/jest.setup.js intentionally leaves the shared mongoose
  // connection and HTTP server open for the whole run (tearing them down per
  // suite broke every suite after the first), so the process needs a push.
  forceExit: true,
  //   extensionsToTreatAsEsm: [".js", ".mjs"],
  moduleFileExtensions: ["js", "mjs", "json"],
  // If you use path aliases via "imports" in package.json, Jest respects them in ESM mode.
  // If not, add "moduleNameMapper" here.
  // Only run setup for integration tests
  setupFilesAfterEnv: ["<rootDir>/tests/setup/jest.setup.js"],
  testMatch: ["**/*.test.js"],
  // Unit tests don't need the MongoDB setup
  projects: [
    {
      displayName: "unit",
      testMatch: ["<rootDir>/tests/units/**/*.test.js"],
      testEnvironment: "node",
      transform: {},
      // Same ESM-only htmlparser2 problem as the integration project below —
      // the unit tests import visibility helpers, which reach sanitize-html.
      moduleNameMapper: {
        "^htmlparser2$": "<rootDir>/node_modules/htmlparser2",
      },
    },
    {
      displayName: "integration",
      testMatch: ["<rootDir>/tests/integrations/**/*.test.js"],
      testEnvironment: "node",
      transform: {},
      setupFilesAfterEnv: ["<rootDir>/tests/setup/jest.setup.js"],
      // See tests/helpers/uuid-shim.cjs — without this, /admin, /files, /og
      // and /servers fail to import and routes/index.js silently skips them,
      // so they 404 in tests while working fine in production.
      moduleNameMapper: {
        "^uuid$": "<rootDir>/tests/helpers/uuid-shim.cjs",
        // sanitize-html@2.17.7 depends on htmlparser2@12, which dropped its
        // CommonJS build (v10 was dual-published; v12 is ESM only).
        // sanitize-html is itself CJS and require()s it — fine under Node 26,
        // which supports require(esm), but Jest's runtime doesn't, so every
        // suite died with "Must use import to load ES Module".
        // Point Jest at the CJS htmlparser2 already in the tree. Production is
        // untouched and still runs v12; only the test runner sees v8, and
        // nothing here has sanitize-html's parsing under test.
        // Removable once Jest supports require(esm).
        "^htmlparser2$": "<rootDir>/node_modules/htmlparser2",
      },
    },
  ],
};
