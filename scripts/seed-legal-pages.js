#!/usr/bin/env node
/**
 * seed-legal-pages.js — publish/refresh the Terms of Service and Privacy
 * Policy pages for THIS server.
 *
 * Publishes: terms, privacy, and (from the live rules setting) rules.
 *
 * Deliberately separate from seed-pages.js: that script also creates about /
 * projects / contact / rules pages, which on a live server may already have
 * been edited by hand. This one touches ONLY those three slugs.
 *
 * Server-specific details (name, domain, admin contact) are read from
 * Settings, so the same boilerplate renders correctly on every server.
 *
 *   node scripts/seed-legal-pages.js            # create if missing
 *   node scripts/seed-legal-pages.js --force    # overwrite existing bodies
 *
 * NOTE: these are plain-language templates, not legal advice. They describe
 * what the software actually does (verified against the code, 2026-10-28):
 * no cookies are set, no third-party analytics exist, IP addresses are held
 * only transiently in memory for rate limiting, and federation is
 * Kowloon-to-Kowloon only — NOT the wider fediverse.
 */
import mongoose from "mongoose";
import { Page, Settings } from "#schema";
import { loadSettings, getSetting } from "#methods/settings/cache.js";

const FORCE = process.argv.includes("--force");

function termsMarkdown({ siteName, domain, adminEmail }) {
  return `# Terms of Service

_Last updated: ${new Date().toISOString().slice(0, 10)}_

These terms cover your use of **${siteName}** (${domain}), a server operated
independently by its administrator. By creating an account here, you agree to
them.

## 1. Who this agreement is with

This agreement is between you and the operator of ${domain}. It applies to
**this server only**.

Kowloon is free, open-source software that anyone may download and run. Other
Kowloon servers are operated by other people, under their own rules. We have
no relationship with them, no control over them, and no responsibility for
them — including for anything their users publish.

## 2. Your account

You must be **at least 13 years old** to hold an account here. If you are
under the age of digital consent where you live, you may need a parent or
guardian's permission.

You are responsible for keeping your password secure and for everything done
through your account.

## 3. Your content is yours, and it is your responsibility

You keep ownership of everything you post. You do not transfer copyright to
us.

By posting, you grant this server permission to store your content and to
display and transmit it to the people and servers you address it to — which
is simply what is required to operate the service you asked us to provide.

**You are solely responsible for what you publish.** Do not post content that
is unlawful, that infringes someone else's rights, or that breaks the
community rules shown when you registered.

## 4. Content published by others

We do not pre-screen content. Anything posted here is the responsibility of
the person who posted it, not of the operator.

If you believe something here breaks the rules or the law, report it in the
app, or contact ${adminEmail}.

## 5. Federation: posts leave this server and cannot be recalled

Kowloon servers exchange content with each other. When you publish something
addressed publicly, or to people on other Kowloon servers, **copies are sent
to those servers and stored there.**

Deleting a post here asks other servers to delete their copies, and well-behaved
ones will. **We cannot guarantee it.** Nor can we stop anyone from screenshotting
or re-posting your content. Please treat anything you publish as potentially
permanent and potentially public.

Kowloon federates with **other Kowloon servers only**. It does not currently
connect to Mastodon or other ActivityPub networks.

## 6. Moderation and suspension

We may remove content or suspend accounts that break these terms or the
community rules, at our discretion. Where it is practical and appropriate we
will explain why, but we are not obliged to.

You may delete your own account at any time from Settings. See the Privacy
Policy for exactly what that removes.

## 7. Copyright complaints

If you believe content here infringes your copyright, contact ${adminEmail}
with: what work you own, where the infringing material is, your contact
details, and a statement that you believe in good faith the use is not
authorised. We will review and remove material where appropriate.

## 8. No warranty

This service is provided **"as is"**, without warranties of any kind. We do
not promise it will be available, uninterrupted, or free of errors, and we do
not promise your data will never be lost. Keep your own copies of anything
you cannot afford to lose.

## 9. Limitation of liability

To the fullest extent the law allows, the operator is not liable for indirect
or consequential losses, for lost data or profits, or for anything published
by another user or by another server.

Nothing here limits liability that cannot lawfully be limited.

## 10. Changes

We may update these terms. Significant changes will be announced on this
server. Continuing to use your account after a change means you accept it.

## 11. Contact

${adminEmail}
`;
}

function privacyMarkdown({ siteName, domain, adminEmail }) {
  return `# Privacy Policy

_Last updated: ${new Date().toISOString().slice(0, 10)}_

This policy covers **${siteName}** (${domain}). Other Kowloon servers are run
by other people and have their own policies.

The short version: we collect what is needed to run the service, we do not
track you, we do not advertise, and we never sell your data.

## What we collect

**You give us:**
- A username and password (stored only as a cryptographic hash — we cannot read it)
- An email address, used for account matters such as password resets and verification
- Anything you choose to put in your profile
- The posts, replies, reactions, bookmarks and files you create

**Automatically:**
- Your IP address is checked briefly in memory to rate-limit abusive traffic.
  **It is not written to our database.**
- Ordinary server operation produces technical logs. These are for diagnosing
  faults and are not used to build any profile of you.

## What we do NOT do

- **No cookies.** This site sets none. Your login is kept in your browser's
  local storage, which exists only to keep you signed in and is cleared when
  you log out.
- **No third-party analytics or trackers.** No Google Analytics, no pixels,
  no advertising networks. Nothing about your visit is sent to a third party.
- **No advertising, and no selling or sharing of your data.**

## Who can see your content

You choose an audience for everything you post: public, this server only, a
specific circle, or just yourself. We enforce that.

**Public posts are visible to anyone on the internet**, including people
without accounts.

## Federation — this is the important part

Kowloon servers pass content to one another. When you publish something
publicly, or address it to someone on another Kowloon server, **a copy is
transmitted to that server and stored there, outside our control.**

If you delete it, we ask those servers to delete their copies too, and
well-behaved ones will — but **we cannot guarantee deletion elsewhere.** Treat
anything you publish as potentially permanent.

Kowloon federates with **other Kowloon servers only** — not with Mastodon or
other ActivityPub software.

## Deleting your account

You can delete your account yourself, from Settings. It is immediate and
permanent. It removes your account record, your posts, replies, reactions,
bookmarks, uploaded files, circles and notifications from this server, and
signs out every device.

Two honest limits:
- **Copies already sent to other servers are not recalled by this.** See
  Federation above.
- If you own a group, ownership transfers to a server administrator rather
  than the group being destroyed, so its other members do not lose it.

## How long we keep things

Your content is kept while your account exists. Delete the account and it goes.
Backups may retain data for a short period after that before being rotated out.

## Security

Passwords are hashed. Traffic is encrypted in transit (HTTPS). Uploaded files
are stored privately and served only to people permitted to see them.

No service can promise perfect security, and we do not.

## Your rights

Depending on where you live, you may have rights to access, correct, export
or erase your personal data. Deletion is self-service in Settings. For
anything else, contact ${adminEmail}.

## Children

This service is not intended for children under 13, and we do not knowingly
collect their data. If you believe a child under 13 has an account here,
contact ${adminEmail}.

## Changes

We may update this policy. Significant changes will be announced on this
server.

## Contact

${adminEmail}
`;
}

function rulesMarkdown({ siteName }, rules) {
  const body = rules
    .map((r, i) => `${i + 1}. ${String(r.text || "").trim()}`)
    .join("\n\n");
  return `# Community Rules

_Last updated: ${new Date().toISOString().slice(0, 10)}_

These are the rules for **${siteName}**. Everyone agrees to them when they
register, and they apply to everything posted here.

${body}

Breaking these may lead to content being removed or an account suspended.
If you think something here breaks them, report it in the app.

See also the [Terms of Service](/pages/terms) and
[Privacy Policy](/pages/privacy).
`;
}

async function main() {
  const uri =
    process.env.MONGO_URI ||
    process.env.MONGODB_URI ||
    process.env.MONGO_URL ||
    process.env.DATABASE_URL;
  if (!uri) throw new Error("No Mongo connection string in the environment");

  await mongoose.connect(uri);
  await loadSettings(Settings);

  const domain = getSetting("domain");
  const siteName =
    getSetting("siteTitle") || getSetting("profile")?.name || "this server";
  const adminEmail = getSetting("adminEmail") || `admin@${domain}`;
  const actorId = getSetting("actorId") || `@${domain}`;
  const ctx = { siteName, domain, adminEmail };

  const defs = [
    {
      slug: "terms",
      title: "Terms of Service",
      summary: "The rules for using this server, and what we are and aren't responsible for.",
      content: termsMarkdown(ctx),
    },
    {
      slug: "privacy",
      title: "Privacy Policy",
      summary: "What we collect, what we don't, and what federation means for your data.",
      content: privacyMarkdown(ctx),
    },
  ];

  // Community rules are stored in Settings and shown at registration, but
  // were unreadable afterwards -- and the site footer links here. Rendered
  // from the live setting, so RE-RUN THIS SCRIPT (with --force) after
  // editing the rules in admin, or the page goes stale.
  const rules = Array.isArray(getSetting("rules")) ? getSetting("rules") : [];
  if (rules.length > 0) {
    defs.push({
      slug: "rules",
      title: "Community Rules",
      summary: "The rules everyone agrees to when they join this server.",
      content: rulesMarkdown(ctx, rules),
    });
  }

  for (const def of defs) {
    const existing = await Page.findOne({ slug: def.slug, deletedAt: null });
    if (existing && !FORCE) {
      console.log(`  = "${def.slug}" already exists (use --force to overwrite)`);
      continue;
    }
    if (existing) {
      existing.title = def.title;
      existing.summary = def.summary;
      existing.source = { content: def.content, mediaType: "text/markdown" };
      await existing.save();
      console.log(`  ~ updated "${def.slug}" → ${existing.id}`);
      continue;
    }
    const page = await Page.create({
      type: "Page",
      actorId,
      title: def.title,
      slug: def.slug,
      summary: def.summary,
      source: { content: def.content, mediaType: "text/markdown" },
      to: "@public",
    });
    console.log(`  + created "${def.slug}" → ${page.id}`);
  }

  console.log(`\nDone for ${domain}.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("seed-legal-pages failed:", err.message);
  process.exit(1);
});
