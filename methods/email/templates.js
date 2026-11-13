// methods/email/templates.js
// HTML email templates for invite and password reset emails.

import { getSetting } from "#methods/settings/cache.js";

function baseLayout(siteName, domain, content) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: sans-serif; background: #f4f4f5; margin: 0; padding: 32px 16px; }
    .card { background: #fff; border-radius: 8px; max-width: 520px; margin: 0 auto; padding: 40px; }
    h1 { font-size: 22px; margin: 0 0 16px; color: #111; }
    p { font-size: 15px; line-height: 1.6; color: #444; margin: 0 0 16px; }
    .btn { display: inline-block; background: #2563eb; color: #fff; text-decoration: none;
           padding: 12px 24px; border-radius: 6px; font-size: 15px; font-weight: 600; }
    .muted { font-size: 13px; color: #888; margin-top: 24px; border-top: 1px solid #e5e7eb; padding-top: 16px; }
    code { background: #f4f4f5; padding: 2px 6px; border-radius: 4px; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${siteName}</h1>
    ${content}
    <p class="muted">This email was sent by ${siteName} (${domain}). If you didn't expect it, you can ignore it.</p>
  </div>
</body>
</html>`;
}

export function inviteEmail({ inviteUrl, email, welcomeMessage, note }) {
  const domain = getSetting("domain") || "localhost";
  const siteName = getSetting("profile")?.name || "Kowloon";

  const greeting = welcomeMessage
    ? `<p>${welcomeMessage}</p>`
    : `<p>You've been invited to join <strong>${siteName}</strong>, a federated social network.</p>`;

  const noteHtml = note ? `<p><em>${note}</em></p>` : "";

  const content = `
    ${greeting}
    ${noteHtml}
    <p>Click the button below to create your account. This invite is for <code>${email}</code> only.</p>
    <p><a class="btn" href="${inviteUrl}">Accept Invitation</a></p>
    <p>Or copy this link:<br><code>${inviteUrl}</code></p>
  `;

  return {
    subject: `You're invited to ${siteName}`,
    html: baseLayout(siteName, domain, content),
  };
}

export function verificationEmail({ verifyUrl }) {
  const domain = getSetting("domain") || "localhost";
  const siteName = getSetting("profile")?.name || "Kowloon";

  const content = `
    <p>Thanks for signing up for <strong>${siteName}</strong>!</p>
    <p>Click the button below to verify your email address. This link expires in 24 hours.</p>
    <p><a class="btn" href="${verifyUrl}">Verify Email Address</a></p>
    <p>Or copy this link:<br><code>${verifyUrl}</code></p>
    <p>If you didn't create an account, you can ignore this email.</p>
  `;

  return {
    subject: `Verify your email address for ${siteName}`,
    html: baseLayout(siteName, domain, content),
  };
}

// The archive lives on the server; it's downloaded from Settings ->
// Maintenance while signed in as an admin. (The old email linked straight
// to the download, which can't work from a mail client: it needs sign-in.)
export function backupReadyEmail({ pageUrl, kind = 'full', size }) {
  const domain = getSetting("domain") || "localhost";
  const siteName = getSetting("profile")?.name || "Kowloon";
  const what = kind === 'database' ? 'database backup' : 'full backup (database and uploaded files)';

  const content = `
    <p>Your <strong>${siteName}</strong> ${what} is ready${size ? ` (${size})` : ''}.</p>
    <p>Download it from <strong>Settings &rarr; Maintenance</strong> while signed in as an admin.</p>
    <p><a class="btn" href="${pageUrl}">Open Maintenance</a></p>
    <p>The backup stays on the server until you delete it there. Keep a copy somewhere else too: a backup on the same machine won't help if the machine is lost.</p>
  `;

  return {
    subject: `Your ${siteName} backup is ready`,
    html: baseLayout(siteName, domain, content),
  };
}

export function backupFailedEmail({ pageUrl, kind = 'full', scheduled = false, error }) {
  const domain = getSetting("domain") || "localhost";
  const siteName = getSetting("profile")?.name || "Kowloon";
  const what = kind === 'database' ? 'database backup' : 'full backup';
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const content = `
    <p>A ${scheduled ? 'scheduled ' : ''}${what} of <strong>${siteName}</strong> failed.</p>
    <p>The error was:<br><code>${esc(error)}</code></p>
    <p>${scheduled ? "The server will try again within the hour. If it keeps failing, check that there's enough free disk space, or ask whoever runs the server." : 'You can try again from Settings &rarr; Maintenance.'}</p>
    <p><a class="btn" href="${pageUrl}">Open Maintenance</a></p>
  `;

  return {
    subject: `${siteName} backup failed`,
    html: baseLayout(siteName, domain, content),
  };
}

export function passwordResetEmail({ resetUrl }) {
  const domain = getSetting("domain") || "localhost";
  const siteName = getSetting("profile")?.name || "Kowloon";

  const content = `
    <p>We received a request to reset your password on <strong>${siteName}</strong>.</p>
    <p>Click the button below to choose a new password. This link expires in 1 hour.</p>
    <p><a class="btn" href="${resetUrl}">Reset Password</a></p>
    <p>Or copy this link:<br><code>${resetUrl}</code></p>
    <p>If you didn't request a password reset, you can ignore this email.</p>
  `;

  return {
    subject: `Reset your ${siteName} password`,
    html: baseLayout(siteName, domain, content),
  };
}
