// methods/seo/meta.js
// Fetch page metadata for a given URL path.
// Used by bot-detection middleware to populate <head> tags for crawlers.

import { FeedItems, User, Group, Page } from "#schema";
import { getSetting } from "#methods/settings/cache.js";
import resolveRequestDomain from "./resolveRequestDomain.js";

function excerpt(html, maxLen = 200) {
  if (!html) return "";
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > maxLen ? text.slice(0, maxLen).replace(/\s+\S*$/, "") + "…" : text;
}

function resolveImageUrl(fileIdOrUrl, domain, proto) {
  if (!fileIdOrUrl) return null;
  if (fileIdOrUrl.startsWith("http")) {
    // Re-encode the path so special chars in file IDs (: @) don't confuse
    // social-media scrapers that mis-parse them as protocol/user-info.
    try {
      const u = new URL(fileIdOrUrl);
      u.pathname = u.pathname.split("/").map(encodeURIComponent).join("/");
      return u.toString();
    } catch {
      return fileIdOrUrl;
    }
  }
  if (fileIdOrUrl.startsWith("file:")) return `${proto}://${domain}/files/${encodeURIComponent(fileIdOrUrl)}`;
  return null;
}

// Returns { title, description, image, url, type, jsonLd }
export async function fetchMeta(pathname, req) {
  const domain = resolveRequestDomain(req);
  const profile = getSetting("profile") || {};
  const siteName = profile.name || "Kowloon";
  const proto = req.headers["x-forwarded-proto"] || "https";
  const base = `${proto}://${domain}`;
  const siteIcon  = profile.icon  ? `${base}/og/icon`  : null;
  const siteHero  = profile.image ? `${base}/og/image` : siteIcon;

  const defaults = {
    title: siteName,
    description: excerpt(profile.description) || `A Kowloon federated server`,
    image: siteHero || siteIcon,
    url: `${base}${pathname}`,
    type: "website",
    siteName,
    kowloonId: null,
    kowloonType: null,
    jsonLd: null,
  };

  // ── / (homepage) ────────────────────────────────────────────────────────────
  if (pathname === "/" || pathname === "") {
    return {
      ...defaults,
      jsonLd: JSON.stringify({
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: siteName,
        url: base,
        description: defaults.description,
      }),
    };
  }

  // ── /posts/:id ───────────────────────────────────────────────────────────────
  const postMatch = pathname.match(/^\/posts\/(.+)$/);
  if (postMatch) {
    const postId = decodeURIComponent(postMatch[1]);
    const item = await FeedItems.findOne({ id: postId, to: "public", tombstoned: { $ne: true } }).lean();
    if (!item) return defaults;
    const obj = item.object ?? {};
    const title = obj.name || obj.title || (item.type === "Note" ? "Note" : item.type) || "Post";
    const description = excerpt(obj.source?.content || obj.body || obj.content || "");
    const image = resolveImageUrl(obj.image, domain, proto) || siteHero || siteIcon;
    const authorName = obj.actor?.name || obj.actor?.preferredUsername || item.actorId;
    const url = `${base}${pathname}`;

    // Event posts get schema.org Event structured data (start/end/location) so
    // they're eligible for event rich results; everything else is an Article.
    let jsonLd;
    if (item.type === "Event") {
      const toIso = (d) => {
        try {
          const x = new Date(d);
          return Number.isNaN(x.getTime()) ? null : x.toISOString();
        } catch {
          return null;
        }
      };
      const ev = {
        "@context": "https://schema.org",
        "@type": "Event",
        name: title,
        description,
        image,
        organizer: { "@type": "Person", name: authorName },
        url,
      };
      const start = toIso(obj.event?.startDate);
      const end = toIso(obj.event?.endDate);
      if (start) ev.startDate = start;
      if (end) ev.endDate = end;
      if (obj.location?.name) ev.location = { "@type": "Place", name: obj.location.name };
      jsonLd = JSON.stringify(ev);
    } else {
      jsonLd = JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Article",
        headline: title,
        description,
        image,
        author: { "@type": "Person", name: authorName },
        datePublished: item.publishedAt,
        url,
      });
    }

    return {
      ...defaults,
      title: `${title} — ${siteName}`,
      description,
      image,
      type: "article",
      kowloonId: item.id,
      kowloonType: "Post",
      jsonLd,
    };
  }

  // ── /users/:id ───────────────────────────────────────────────────────────────
  const userMatch = pathname.match(/^\/users\/(.+)$/);
  if (userMatch) {
    const userId = decodeURIComponent(userMatch[1]);
    const user = await User.findOne({ id: userId, active: true }).lean();
    if (!user) return defaults;
    const name = user.profile?.name || user.username;
    const image = resolveImageUrl(user.profile?.icon, domain, proto) || siteHero || siteIcon;
    return {
      ...defaults,
      title: `${name} — ${siteName}`,
      description: excerpt(user.profile?.description || `${name} on ${siteName}`),
      image,
      type: "profile",
      kowloonId: user.id,
      kowloonType: "User",
      jsonLd: JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Person",
        name,
        description: user.profile?.description || "",
        image,
        url: `${base}${pathname}`,
      }),
    };
  }

  // ── /groups/:id ──────────────────────────────────────────────────────────────
  const groupMatch = pathname.match(/^\/groups\/(.+)$/);
  if (groupMatch) {
    const groupId = decodeURIComponent(groupMatch[1]);
    const group = await Group.findOne({ id: groupId, to: "@public", deletedAt: null }).lean();
    if (!group) return defaults;
    const image = resolveImageUrl(group.icon, domain, proto) || siteHero || siteIcon;
    return {
      ...defaults,
      title: `${group.name} -- ${siteName}`,
      description: excerpt(group.summary || `${group.name} group on ${siteName}`),
      image,
      type: "website",
      kowloonId: group.id,
      kowloonType: "Group",
      jsonLd: JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Organization",
        name: group.name,
        description: group.summary || "",
        image,
        url: `${base}${pathname}`,
      }),
    };
  }

  // ── /pages/:id ───────────────────────────────────────────────────────────────
  const pageMatch = pathname.match(/^\/pages\/(.+)$/);
  if (pageMatch) {
    const idOrSlug = decodeURIComponent(pageMatch[1]);
    const page =
      (await Page.findOne({ id: idOrSlug, deletedAt: null }).lean()) ||
      (await Page.findOne({ slug: idOrSlug, deletedAt: null }).lean());
    if (!page) return defaults;
    const image = resolveImageUrl(page.image, domain, proto) || siteHero || siteIcon;
    return {
      ...defaults,
      title: `${page.title} — ${siteName}`,
      description: excerpt(page.body || page.source?.content || ""),
      image,
      type: "article",
      kowloonId: page.id,
      kowloonType: "Page",
      jsonLd: JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Article",
        headline: page.title,
        description: excerpt(page.body || ""),
        image,
        url: `${base}${pathname}`,
      }),
    };
  }

  return defaults;
}
