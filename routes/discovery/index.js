// routes/discovery/index.js
// GET /discovery — the curated Discover surface.
//
// Returns active DiscoverySections in order, each resolved to its visible
// items. Viewer-aware: authenticated LOCAL users see public + server-tier
// items; everyone else (logged-out, remote users, other servers) sees public
// only — the same tiered gate used by /circles and /posts.
//
// Discovery items store only a reference, so each target is resolved live here
// and dropped if it was deleted or its visibility narrowed after being curated.

import express from "express";
import route from "../utils/route.js";
import {
  Discovery,
  DiscoverySection,
  Post,
  Circle,
  Group,
  Bookmark,
  Page,
  FederatedServer,
  Settings,
  FeedItems,
} from "#schema";
import { getSetting } from "#methods/settings/cache.js";
import isLocalDomain from "#methods/parse/isLocalDomain.js";
import kowloonId from "#methods/parse/kowloonId.js";
import { buildFileUrl } from "#methods/files/signedUrl.js";
import getHeuristicPicks, { fiToPostDoc } from "#methods/discover/heuristic.js";

const router = express.Router({ mergeParams: true });

// Coarse visibility tier from an object's `to` field.
function tierOf(to, domain) {
  if (to === "@public" || to === "public") return "public";
  if (to === `@${domain}` || to === "@server" || to === "server") return "server";
  return "private"; // circle-/user-addressed, audience, empty — never surfaced
}

function visibleToViewer(tier, isLocal) {
  if (tier === "public") return true;
  if (tier === "server") return !!isLocal;
  return false;
}

function resolveImg(img, domain, protocol, restricted) {
  if (!img || typeof img !== "string") return null;
  if (img.startsWith("file:")) {
    // A remote file (id domain != local) lives on its origin server — this
    // server can't serve it, so build the URL against the origin domain
    // (public, unsigned). Local files stay here (signed if restricted). (#36)
    const parsed = kowloonId(img);
    if (parsed?.domain && !isLocalDomain(parsed.domain)) {
      return buildFileUrl({ fileId: img, domain: parsed.domain, protocol, restricted: false });
    }
    return buildFileUrl({ fileId: img, domain, protocol, restricted });
  }
  return img; // already an http(s) URL
}

// Shape a resolved target into a compact card the client can render by refType.
function shapeCard(refType, doc, note, { domain, protocol, restricted }) {
  const base = { id: doc.id, refType, to: doc.to, note: note || null };
  switch (refType) {
    case "Post": {
      // Media posts keep their images in `attachments`, not `image`; expose a
      // best-effort thumbnail for the media row (featured, else first
      // attachment). Attachments are stored fully-resolved (fileId/kind/
      // mediaType/name already inline) — no File lookup needed to classify.
      const firstAtt = Array.isArray(doc.attachments) ? doc.attachments[0] : null;
      return {
        ...base,
        type: doc.type,
        title: doc.title || null,
        summary: doc.summary || null,
        // Plain-text body preview so Note cards (which have no title) still show
        // content. Same field the feed card falls back to.
        preview: doc.textPreview || null,
        featuredImage: resolveImg(doc.image, domain, protocol, restricted),
        mediaImage: resolveImg(doc.image || firstAtt?.fileId, domain, protocol, restricted),
        // First-attachment metadata (only when there's no featured image) so the
        // media enrichment pass can classify kind (photo/video/audio) below.
        _firstAtt: doc.image ? null : firstAtt || null,
        actor: doc.actor
          ? { id: doc.actorId, name: doc.actor.name, icon: doc.actor.icon }
          : { id: doc.actorId },
        url: doc.url || null,
      };
    }
    case "Circle":
      return {
        ...base,
        name: doc.name || null,
        summary: doc.summary || null,
        icon: resolveImg(doc.icon, domain, protocol, restricted),
        memberCount: doc.memberCount ?? null,
        actorId: doc.actorId || null,
      };
    case "Group":
      return {
        ...base,
        name: doc.name || null,
        description: doc.description || null,
        icon: resolveImg(doc.icon, domain, protocol, restricted),
        image: resolveImg(doc.image, domain, protocol, restricted),
        memberCount: doc.memberCount ?? null,
        rsvpPolicy: doc.rsvpPolicy || null,
      };
    case "Bookmark":
      return {
        ...base,
        title: doc.title || null,
        summary: doc.summary || null,
        image: resolveImg(doc.image, domain, protocol, restricted),
        href: doc.href || null,
      };
    case "Page":
      return {
        ...base,
        title: doc.title || null,
        summary: doc.summary || null,
        featuredImage: resolveImg(doc.image, domain, protocol, restricted),
        url: doc.url || null,
      };
    case "Server":
      // Resolved from the FederatedServer cache; keyed by domain, always public.
      return {
        id: `@${doc.domain}`,
        refType: "Server",
        note: note || null,
        domain: doc.domain,
        name: doc.name || doc.domain,
        description: doc.description || null,
        icon: doc.icon || null, // remote absolute URL
        image: doc.image || null,
        userCount: doc.userCount ?? null,
        url: doc.url || `https://${doc.domain}`,
      };
    default:
      return null;
  }
}

const MODELS = { Post, Circle, Group, Bookmark, Page };

router.get(
  "/",
  route(
    async ({ req, user, set }) => {
      const domain = getSetting("domain");
      const protocol = req.headers["x-forwarded-proto"] || "https";

      // The blurred/darkened Discover background so a single fetch gives clients
      // both the shelves and the backdrop (used by the remote-server Discover).
      const bgDoc = await Settings.findOne({ name: "discoverBackground", deletedAt: null })
        .select("value")
        .lean();
      const background = bgDoc?.value || null;

      let isLocal = false;
      if (user?.id) {
        const parsed = kowloonId(user.id);
        isLocal = !!(parsed.domain && isLocalDomain(parsed.domain));
      }

      // Active sections visible to this viewer, in order.
      const sections = await DiscoverySection.find({
        deletedAt: null,
        active: true,
      })
        .sort({ order: 1, createdAt: 1 })
        .lean();

      const visibleSections = sections.filter((s) =>
        visibleToViewer(tierOf(s.to, domain), isLocal)
      );
      if (visibleSections.length === 0) {
        set("@context", "https://www.w3.org/ns/activitystreams");
        set("type", "Collection");
        set("background", background);
        set("sections", []);
        return;
      }

      const sectionIds = visibleSections.map((s) => s.id);
      const recs = await Discovery.find({
        section: { $in: sectionIds },
        deletedAt: null,
        active: true,
      })
        .sort({ order: 1, createdAt: 1 })
        .lean();

      // Batch-resolve targets by type (one query per model).
      const byType = new Map(); // refType -> Set(ref)
      for (const r of recs) {
        if (!r.refType || !MODELS[r.refType]) continue;
        if (!byType.has(r.refType)) byType.set(r.refType, new Set());
        byType.get(r.refType).add(r.ref);
      }

      const resolved = new Map(); // ref -> raw doc
      await Promise.all(
        [...byType.entries()].map(async ([refType, refs]) => {
          // Curated Posts resolve from FeedItems (the unified local+remote public
          // store), not the local Post model — so a curated *remote* post
          // resolves too, and Discover matches what the feed shows. Same adapter
          // the heuristic uses.
          if (refType === "Post") {
            const fis = await FeedItems.find({
              id: { $in: [...refs] },
              objectType: "Post",
              tombstoned: { $ne: true },
            }).lean();
            for (const fi of fis) resolved.set(fi.id, fiToPostDoc(fi, domain));
            return;
          }
          const docs = await MODELS[refType]
            .find({ id: { $in: [...refs] }, deletedAt: null })
            .lean();
          for (const d of docs) resolved.set(d.id, d);
        })
      );

      // Resolve Server refs (@domain) from the FederatedServer cache, keyed by
      // the "@domain" ref so the assembly loop finds them the same way.
      const serverRefs = recs.filter((r) => r.refType === "Server").map((r) => r.ref);
      if (serverRefs.length) {
        const domains = serverRefs.map((r) => r.replace(/^@/, "").toLowerCase());
        const servers = await FederatedServer.find({
          domain: { $in: domains },
          status: { $nin: ["suspended", "blocked"] },
        }).lean();
        const byDomain = new Map(servers.map((s) => [s.domain.toLowerCase(), s]));
        for (const ref of serverRefs) {
          const s = byDomain.get(ref.replace(/^@/, "").toLowerCase());
          if (s) resolved.set(ref, s);
        }
      }

      // Assemble each section's visible items.
      const out = [];
      for (const s of visibleSections) {
        const items = [];
        const curatedRefs = new Set();
        for (const r of recs) {
          if (r.section !== s.id) continue;
          const doc = resolved.get(r.ref);
          if (!doc) continue; // deleted or never resolvable
          if (r.refType === "Server") {
            // Servers are public discovery items — no `to`-tier gate.
            const card = shapeCard("Server", doc, r.note, { domain, protocol, restricted: false });
            if (card) { items.push(card); curatedRefs.add(r.ref); }
            continue;
          }
          const tier = tierOf(doc.to, domain);
          if (!visibleToViewer(tier, isLocal)) continue; // narrowed since curated
          const card = shapeCard(r.refType, doc, r.note, {
            domain,
            protocol,
            restricted: tier !== "public",
          });
          if (card) { items.push(card); curatedRefs.add(r.ref); }
        }

        // Heuristic backfill for hybrid/heuristic rows. Curated picks come first
        // and bypass the completeness boost (decision 4); the heuristic fills the
        // remainder up to targetCount, excluding anything already curated.
        if ((s.source === "hybrid" || s.source === "heuristic") && s.contentType) {
          const need = (s.targetCount || 12) - items.length;
          if (need > 0) {
            const picks = await getHeuristicPicks({
              contentType: s.contentType,
              isLocal,
              localDomain: domain,
              excludeRefs: curatedRefs,
              limit: need,
            });
            for (const p of picks) {
              const restricted =
                p.refType === "Server" ? false : tierOf(p.doc.to, domain) !== "public";
              const card = shapeCard(p.refType, p.doc, null, { domain, protocol, restricted });
              if (card) items.push(card);
            }
          }
        }

        if (items.length === 0) continue; // hide empty shelves
        out.push({
          id: s.id,
          name: s.name,
          slug: s.slug,
          summary: s.summary || null,
          contentType: s.contentType || null,
          source: s.source || "hybrid",
          targetCount: s.targetCount ?? null,
          order: s.order,
          items,
        });
      }

      // Classify media-row items by their first attachment's kind (photo/video/
      // audio), so the client can render a video/audio player instead of a
      // broken image tile. kind/mediaType/name are already resolved on the
      // stored Attachment subdocument — no File lookup needed.
      for (const s of out) {
        if (s.contentType !== "media") continue;
        for (const it of s.items) {
          const att = it._firstAtt;
          const kind = att?.kind === "video" || att?.kind === "audio" ? att.kind : "image";
          it.mediaKind = kind;
          it.mediaName = att?.name || it.title || null;
          // For video/audio, mediaImage is the playable file URL — expose it as
          // mediaUrl and clear mediaImage so the client draws a player tile.
          if (it.mediaKind !== "image") {
            it.mediaUrl = it.mediaImage;
            it.mediaImage = null;
          }
        }
      }
      // Drop the internal helper before serializing.
      for (const s of out) for (const it of s.items) delete it._firstAtt;

      set("@context", "https://www.w3.org/ns/activitystreams");
      set("type", "Collection");
      set("background", background);
      set("sections", out);
    },
    { allowUnauth: true }
  )
);

export default router;
