// Test-only stand-in for the `uuid` package.
//
// uuid@14 is "type": "module" and ships ESM only. Jest's experimental VM
// modules resolver decides it's CJS anyway ("Must use import to load ES
// Module"), and because transformIgnorePatterns skips node_modules there's
// no transform to rescue it. routes/index.js catches the resulting import
// failure and silently skips the router, so /admin, /files, /og and
// /servers all 404'd in tests while working perfectly in production — the
// failure looked like a missing route rather than a broken import.
//
// The only thing anything actually imports from uuid is v4 (the AWS SDK's
// @smithy/middleware-retry, reached through the S3 storage adapter), so a
// crypto-backed v4 is a complete substitute. Being CJS, Jest loads it
// happily and Node's interop gives ESM importers the named export.
//
// Delete this and the moduleNameMapper entry in jest.config.js if Jest ever
// resolves ESM-only packages correctly.

const { randomUUID } = require("node:crypto");

const v4 = () => randomUUID();

module.exports = { v4, default: { v4 } };
