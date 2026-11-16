// New servers get Terms, Privacy and Rules pages automatically, filled in
// with the server's own details, and restarts never undo the admin's edits
// or deletions.
import { Page } from "#schema";
import { getSetting } from "#methods/settings/cache.js";
import { ensureLegalPages } from "#methods/pages/legalPages.js";

beforeAll(async () => {
  await Page.deleteMany({ slug: { $in: ["terms", "privacy", "rules"] } });
});

test("creates the missing pages with this server's details", async () => {
  const { created } = await ensureLegalPages();
  expect(created).toEqual(expect.arrayContaining(["terms", "privacy"]));

  const terms = await Page.findOne({ slug: "terms" }).lean();
  expect(terms.to).toBe("@public");
  expect(terms.source.content).toContain(getSetting("domain"));
});

test("running again changes nothing and keeps the admin's edits", async () => {
  await Page.updateOne({ slug: "terms" }, { $set: { "source.content": "Our own terms" } });
  const { created, updated } = await ensureLegalPages();
  expect(created).toEqual([]);
  expect(updated).toEqual([]);
  expect((await Page.findOne({ slug: "terms" }).lean()).source.content).toBe("Our own terms");
});

test("a page the admin deleted stays deleted", async () => {
  await Page.updateOne({ slug: "privacy" }, { $set: { deletedAt: new Date() } });
  const { created } = await ensureLegalPages();
  expect(created).not.toContain("privacy");
  expect(await Page.findOne({ slug: "privacy", deletedAt: null })).toBeNull();
});

test("force rewrites live pages from the templates", async () => {
  const { updated } = await ensureLegalPages({ force: true });
  expect(updated).toContain("terms");
  expect((await Page.findOne({ slug: "terms" }).lean()).source.content).not.toBe("Our own terms");
});
