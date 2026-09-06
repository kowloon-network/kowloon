// methods/email/index.js
// Thin nodemailer wrapper. In dev (no SMTP host configured), uses Ethereal
// and logs a preview URL to the console instead of delivering.

import nodemailer from "nodemailer";
import { getSetting } from "#methods/settings/cache.js";
import logger from "#methods/utils/logger.js";

let _etherealTransport = null;

async function getTransport() {
  const cfg = getSetting("emailServer") || {};
  const host = cfg.host;
  const hasSmtp = host && host !== "localhost" && host !== "";

  if (!hasSmtp) {
    if (!_etherealTransport) {
      const testAccount = await nodemailer.createTestAccount();
      _etherealTransport = nodemailer.createTransport({
        host: "smtp.ethereal.email",
        port: 587,
        auth: { user: testAccount.user, pass: testAccount.pass },
      });
      logger.info(`[email] No SMTP configured — using Ethereal (${testAccount.user})`);
    }
    return { transport: _etherealTransport, preview: true };
  }

  const transport = nodemailer.createTransport({
    host,
    port: cfg.port || 587,
    secure: (cfg.port || 587) === 465,
    auth: cfg.username ? { user: cfg.username, pass: cfg.password } : undefined,
  });

  return { transport, preview: false };
}

export async function sendEmail({ to, subject, html, text }) {
  const domain = getSetting("domain") || "localhost";
  const siteName = getSetting("profile")?.name || "Kowloon";
  const cfg = getSetting("emailServer") || {};

  const { transport, preview } = await getTransport();

  // The From address has to be one the SMTP relay is actually authorized to
  // send as -- Mailgun (like most relays) DKIM/SPF-signs for its own
  // authenticated account's domain, not whatever adminEmail happens to be.
  // adminEmail is a personal contact address (cert-expiry warnings etc.),
  // not necessarily on a domain Mailgun has any authority over -- using it
  // as From made every server email look exactly like a spoofed message
  // (visible From domain != the domain that actually sent it) and land in
  // spam. Prefer an explicit override (emailServer.from), then the SMTP
  // login itself (always deliverable, since it's the authenticated
  // account), then fall back to adminEmail only for the Ethereal/dev case
  // where real deliverability doesn't matter.
  const fromAddress =
    cfg.from ||
    (!preview && cfg.username) ||
    getSetting("adminEmail") ||
    `noreply@${domain}`;

  const info = await transport.sendMail({
    from: `"${siteName}" <${fromAddress}>`,
    to,
    subject,
    html,
    text: text || html.replace(/<[^>]+>/g, ""),
  });

  if (preview) {
    logger.info(`[email] Preview: ${nodemailer.getTestMessageUrl(info)}`);
  }

  return info;
}
