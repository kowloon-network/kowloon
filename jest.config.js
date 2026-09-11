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
      },
    },
  ],
};
