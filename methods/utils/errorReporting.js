// Server-side error reporting -> our own GlitchTip at errors.kowloon.network.
//
// GlitchTip speaks Sentry's protocol, so the stock @sentry/node SDK works
// unchanged; only the DSN host differs. Self-hosted deliberately: Josh wants
// as few third-party dependencies as possible, and nothing about Kowloon's
// users should leave infrastructure he controls.
//
// A complete no-op when SENTRY_DSN isn't set, so local dev and any server
// that hasn't been configured behave exactly as before.
//
// Import this FIRST in index.js -- the SDK has to install its global
// handlers before anything else can throw.
import * as Sentry from "@sentry/node";

const dsn = process.env.SENTRY_DSN;

export const errorReportingEnabled = !!dsn;

if (dsn) {
  Sentry.init({
    dsn,
    // Which server a report came from. All four run the same image, so
    // without this every issue looks identical.
    serverName: process.env.DOMAIN || "unknown",
    environment: process.env.NODE_ENV || "production",
    // Kowloon's pitch is privacy, and one community on here is a
    // reproductive-rights group. Never ship request bodies, headers,
    // cookies or IPs to the error store -- a stack trace is the point,
    // user content is not. These are the SDK defaults today; pinned so a
    // future default change can't quietly start sending them.
    sendDefaultPii: false,
    // Performance tracing off: it samples real request data and we have no
    // use for it here.
    tracesSampleRate: 0,
    beforeSend(event) {
      // Belt and braces -- strip anything request-shaped that slipped in.
      if (event.request) {
        delete event.request.cookies;
        delete event.request.data;
        delete event.request.headers;
      }
      if (event.user) delete event.user.ip_address;
      return event;
    },
  });
}

// Report a handled error without crashing the process. Safe no-op when
// reporting is disabled.
export function reportError(err, context) {
  if (!dsn) return;
  try {
    Sentry.captureException(err, context ? { extra: context } : undefined);
  } catch {
    /* never let error reporting cause an error */
  }
}

export { Sentry };
