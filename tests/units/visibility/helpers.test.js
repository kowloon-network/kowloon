import {
  canSeeObject,
  sanitizeAudience,
  canInteract,
} from "#methods/visibility/helpers.js";

describe("Visibility Helpers", () => {
  const ctxKwln = {
    isAuthenticated: true,
    viewerId: "@alice@kwln.org",
    viewerDomain: "kwln.org",
    circleIds: new Set(["circle:c1@kwln.org"]),
    groupIds: new Set(["group:g1@kwln.org"]),
    blockedActorIds: new Set(["@blocked@kwln.org"]),
  };

  const ctxAnonymous = {
    isAuthenticated: false,
    viewerId: null,
    viewerDomain: null,
    circleIds: new Set(),
    groupIds: new Set(),
    blockedActorIds: new Set(),
  };

  const ctxOtherDomain = {
    isAuthenticated: true,
    viewerId: "@bob@kwln.social",
    viewerDomain: "kwln.social",
    circleIds: new Set(["circle:c2@kwln.social"]),
    groupIds: new Set(),
    blockedActorIds: new Set(),
  };

  describe("canSeeObject", () => {
    test("@public is visible to anyone (authenticated)", async () => {
      expect(await canSeeObject({ to: "@public" }, ctxKwln)).toBe(true);
    });

    test("@public is visible to anonymous users", async () => {
      expect(await canSeeObject({ to: "@public" }, ctxAnonymous)).toBe(true);
      expect(await canSeeObject({ to: "@public" }, null)).toBe(true);
    });

    test("domain-scoped content visible to domain members", async () => {
      expect(await canSeeObject({ to: "@kwln.org" }, ctxKwln)).toBe(true);
    });

    test("domain-scoped content NOT visible to other domains", async () => {
      expect(await canSeeObject({ to: "@kwln.org" }, ctxOtherDomain)).toBe(false);
      expect(await canSeeObject({ to: "@kwln.social" }, ctxKwln)).toBe(false);
    });

    test("domain-scoped content NOT visible to anonymous", async () => {
      expect(await canSeeObject({ to: "@kwln.org" }, ctxAnonymous)).toBe(false);
    });

    test("circle-scoped content visible to circle members", async () => {
      expect(await canSeeObject({ to: "circle:c1@kwln.org" }, ctxKwln)).toBe(true);
    });

    test("circle-scoped content NOT visible to non-members", async () => {
      expect(await canSeeObject({ to: "circle:c1@kwln.org" }, ctxOtherDomain)).toBe(
        false
      );
      expect(await canSeeObject({ to: "circle:other@kwln.org" }, ctxKwln)).toBe(
        false
      );
    });

    test("circle-scoped content NOT visible to anonymous", async () => {
      expect(await canSeeObject({ to: "circle:c1@kwln.org" }, ctxAnonymous)).toBe(
        false
      );
    });

    test("group-scoped content visible to group members", async () => {
      expect(await canSeeObject({ to: "group:g1@kwln.org" }, ctxKwln)).toBe(true);
    });

    test("group-scoped content NOT visible to non-members", async () => {
      expect(await canSeeObject({ to: "group:g1@kwln.org" }, ctxOtherDomain)).toBe(
        false
      );
      expect(await canSeeObject({ to: "group:other@kwln.org" }, ctxKwln)).toBe(
        false
      );
    });

    test("group-scoped content NOT visible to anonymous", async () => {
      expect(await canSeeObject({ to: "group:g1@kwln.org" }, ctxAnonymous)).toBe(
        false
      );
    });

    test("null object returns false", async () => {
      expect(await canSeeObject(null, ctxKwln)).toBe(false);
    });

    test("object without 'to' field returns false", async () => {
      expect(await canSeeObject({}, ctxKwln)).toBe(false);
    });
  });

  describe("canInteract", () => {
    test("anonymous users cannot interact", () => {
      expect(canInteract("@public", "@bob@kwln.org", ctxAnonymous)).toBe(
        false
      );
      expect(canInteract("@public", "@bob@kwln.org", null)).toBe(false);
    });

    test("object author can always interact", () => {
      expect(canInteract("@public", "@alice@kwln.org", ctxKwln)).toBe(true);
      expect(canInteract("@kwln.social", "@alice@kwln.org", ctxKwln)).toBe(
        true
      );
      expect(canInteract("circle:other@kwln.org", "@alice@kwln.org", ctxKwln)).toBe(
        true
      );
    });

    test("@public allows all authenticated users to interact", () => {
      expect(canInteract("@public", "@bob@kwln.org", ctxKwln)).toBe(true);
      expect(canInteract("@public", "@carol@kwln.social", ctxOtherDomain)).toBe(
        true
      );
    });

    test("domain-scoped allows only same domain users", () => {
      expect(canInteract("@kwln.org", "@carol@kwln.org", ctxKwln)).toBe(true);
      expect(canInteract("@kwln.org", "@carol@kwln.org", ctxOtherDomain)).toBe(
        false
      );
      expect(canInteract("@kwln.social", "@carol@kwln.social", ctxKwln)).toBe(false);
    });

    test("circle-scoped allows only circle members", () => {
      expect(canInteract("circle:c1@kwln.org", "@bob@kwln.org", ctxKwln)).toBe(
        true
      );
      expect(
        canInteract("circle:c1@kwln.org", "@bob@kwln.org", ctxOtherDomain)
      ).toBe(false);
      expect(
        canInteract("circle:other@kwln.org", "@bob@kwln.org", ctxKwln)
      ).toBe(false);
    });

    test("group-scoped allows only group members", () => {
      expect(canInteract("group:g1@kwln.org", "@bob@kwln.org", ctxKwln)).toBe(
        true
      );
      expect(
        canInteract("group:g1@kwln.org", "@bob@kwln.org", ctxOtherDomain)
      ).toBe(false);
      expect(canInteract("group:other@kwln.org", "@bob@kwln.org", ctxKwln)).toBe(
        false
      );
    });
  });

  describe("sanitizeAudience", () => {
    test("@public content shows visibility=public", () => {
      const out = sanitizeAudience(
        { to: "@public", actorId: "@bob@kwln.org" },
        ctxKwln
      );
      expect(out.visibility).toBe("public");
      expect(out.to).toBe("@public");
    });

    test("domain-scoped content shows visibility=domain", () => {
      const out = sanitizeAudience(
        { to: "@kwln.org", actorId: "@bob@kwln.org" },
        ctxKwln
      );
      expect(out.visibility).toBe("domain");
      expect(out.to).toBe("@kwln.org"); // Keep exact token
    });

    test("circle-scoped content masks circle ID as @private", () => {
      const out = sanitizeAudience(
        { to: "circle:c1@kwln.org", actorId: "@bob@kwln.org" },
        ctxKwln
      );
      expect(out.visibility).toBe("circle");
      expect(out.to).toBe("@private"); // Masked!
    });

    test("group-scoped content shows visibility=group", () => {
      const out = sanitizeAudience(
        { to: "group:g1@kwln.org", actorId: "@bob@kwln.org" },
        ctxKwln
      );
      expect(out.visibility).toBe("group");
      expect(out.to).toBe("group:g1@kwln.org"); // Keep group ID
    });

    test("canReply computed from canReply field or to field", () => {
      const obj1 = {
        to: "@public",
        canReply: "circle:c1@kwln.org",
        actorId: "@bob@kwln.org",
      };
      const out1 = sanitizeAudience(obj1, ctxKwln);
      expect(out1.canReply).toBe(true); // Alice is in circle:c1

      const obj2 = { to: "@public", actorId: "@bob@kwln.org" };
      const out2 = sanitizeAudience(obj2, ctxKwln);
      expect(out2.canReply).toBe(true); // Falls back to `to` (@public)

      const obj3 = {
        to: "@public",
        canReply: "circle:other@kwln.org",
        actorId: "@bob@kwln.org",
      };
      const out3 = sanitizeAudience(obj3, ctxKwln);
      expect(out3.canReply).toBe(false); // Alice not in circle:other
    });

    test("canReact computed from canReact field or to field", () => {
      const obj1 = {
        to: "@public",
        canReact: "@kwln.org",
        actorId: "@bob@kwln.org",
      };
      const out1 = sanitizeAudience(obj1, ctxKwln);
      expect(out1.canReact).toBe(true); // Alice is on kwln.org

      const obj2 = { to: "@public", actorId: "@bob@kwln.org" };
      const out2 = sanitizeAudience(obj2, ctxKwln);
      expect(out2.canReact).toBe(true); // Falls back to `to` (@public)

      const obj3 = {
        to: "@public",
        canReact: "@kwln.social",
        actorId: "@bob@kwln.org",
      };
      const out3 = sanitizeAudience(obj3, ctxKwln);
      expect(out3.canReact).toBe(false); // Alice not on kwln.social
    });

    test("null object returns null", () => {
      expect(sanitizeAudience(null, ctxKwln)).toBe(null);
    });

    test("does not mutate original object", () => {
      const original = { to: "circle:c1@kwln.org", actorId: "@bob@kwln.org" };
      const out = sanitizeAudience(original, ctxKwln);
      expect(original.to).toBe("circle:c1@kwln.org"); // Original unchanged
      expect(out.to).toBe("@private"); // Output masked
    });
  });
});
