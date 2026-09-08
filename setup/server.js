// setup/server.js
// Kowloon installation wizard server.
// Serves the installer UI, validates input, writes .env + docker-compose.yml
// + Caddyfile to /config (mounted volume), then exits so install.sh can
// proceed with `docker compose up`.

import express from "express";
import { writeFileSync, existsSync } from "fs";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import crypto from "crypto";
import dns from "dns/promises";
import os from "os";
import nodemailer from "nodemailer";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 2999;
const CONFIG_DIR = process.env.CONFIG_DIR || "/config";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Routes ────────────────────────────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.sendFile(join(__dirname, "index.html"));
});

// Already configured?
app.get("/status", (_req, res) => {
  res.json({ configured: existsSync(join(CONFIG_DIR, ".env")) });
});

// DNS check — non-blocking, returns whether domain resolves
app.get("/check-dns", async (req, res) => {
  const domain = String(req.query.domain || "").trim();
  if (!domain) return res.json({ ok: false, error: "No domain provided" });
  try {
    const addresses = await dns.resolve4(domain);
    const serverIp = await getPublicIp();
    const pointsHere = serverIp ? addresses.includes(serverIp) : null;
    res.json({ ok: true, addresses, serverIp, pointsHere });
  } catch {
    res.json({ ok: false, addresses: [], serverIp: await getPublicIp() });
  }
});

// SMTP test — sends a real test email using the supplied credentials
app.post("/test-smtp", async (req, res) => {
  const { smtpHost, smtpPort, smtpUser, smtpPass, adminEmail, domain } = req.body;

  if (!smtpHost?.trim()) {
    return res.status(400).json({ ok: false, error: "Enter an SMTP host." });
  }
  if (!adminEmail?.trim()) {
    return res.status(400).json({ ok: false, error: "Enter an admin email address first." });
  }

  const port = parseInt(smtpPort?.trim() || "587", 10);
  const transporter = nodemailer.createTransport({
    host: smtpHost.trim(),
    port,
    secure: port === 465,
    auth: smtpUser?.trim()
      ? { user: smtpUser.trim(), pass: smtpPass?.trim() || "" }
      : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
  });

  // Build a valid from address. SMTP usernames (e.g. "resend", "apikey") are
  // not email addresses, so fall back to noreply@<their domain>.
  const cleanDomain = domain?.trim().replace(/^https?:\/\//, "") || smtpHost.trim();
  const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  const fromAddr = isEmail(smtpUser?.trim())
    ? smtpUser.trim()
    : `noreply@${cleanDomain}`;

  try {
    await transporter.sendMail({
      from: fromAddr,
      to: adminEmail.trim(),
      subject: "Kowloon SMTP test",
      text: "Your Kowloon email settings are working. You can safely ignore this message.",
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Main install endpoint
app.post("/setup", async (req, res) => {
  const {
    domain,
    siteTitle,
    adminUsername,
    adminDisplayName,
    adminEmail,
    adminPassword,
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPass,
    manageSsl,   // "on" if user checked the self-managed SSL toggle
    appPort,     // port number when manageSsl is on
    coHost,      // "on" if this server shares a box with another Kowloon server
    edgeNetwork, // shared docker network name the front-door Caddy lives on
  } = req.body;

  // ── Validate ────────────────────────────────────────────────────────────────
  const errors = [];
  if (!domain?.trim())          errors.push("Domain is required.");
  if (!siteTitle?.trim())       errors.push("Site name is required.");
  if (!adminUsername?.trim())   errors.push("Username is required.");
  if (!/^[a-z0-9_]{2,32}$/.test(adminUsername?.trim() ?? ""))
    errors.push("Username must be 2–32 lowercase letters, numbers, or underscores.");
  if (!adminEmail?.trim())      errors.push("Admin email is required.");
  if (!adminPassword || adminPassword.length < 10)
    errors.push("Password must be at least 10 characters.");

  if (errors.length) return res.status(400).json({ errors });

  // ── Generate secrets ────────────────────────────────────────────────────────
  const jwtSecret    = crypto.randomBytes(48).toString("base64url");
  const s3AccessKey  = crypto.randomBytes(12).toString("hex");
  const s3SecretKey  = crypto.randomBytes(24).toString("hex");
  const cleanDomain  = domain.trim().toLowerCase().replace(/^https?:\/\//, "");
  const cleanTitle   = siteTitle.trim();
  const cleanUser    = adminUsername.trim().toLowerCase();
  const displayName  = (adminDisplayName?.trim()) || cleanUser;
  const selfManagedSsl = manageSsl === "on";
  const port         = Math.min(65535, Math.max(1, parseInt(appPort?.trim() || "3000", 10) || 3000));

  // ── Co-host mode ──────────────────────────────────────────────────────────
  // When this box already runs another Kowloon server, we don't bundle a Caddy
  // (only one container can own :80/:443) and we don't publish a host port.
  // Instead the app joins a shared external network ("${edgeNet}") under a unique
  // alias, and the existing Kowloon stack's Caddy reverse-proxies this domain to
  // that alias. Everything else (Mongo, MinIO, workers) stays private per-stack.
  const isCoHost = coHost === "on";
  const edgeNet  = (edgeNetwork?.trim() || "kowloon-edge").replace(/[^a-zA-Z0-9_.-]/g, "");
  const domainSlug = cleanDomain.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const appAlias   = `app-${domainSlug}`;

  // ── Write .env ──────────────────────────────────────────────────────────────
  const smtpLines = smtpHost?.trim()
    ? [
        `SMTP_HOST=${smtpHost.trim()}`,
        `SMTP_PORT=${smtpPort?.trim() || "587"}`,
        `SMTP_USER=${smtpUser?.trim() || ""}`,
        `SMTP_PASS=${smtpPass?.trim() || ""}`,
      ].join("\n")
    : "# SMTP_HOST=\n# SMTP_PORT=587\n# SMTP_USER=\n# SMTP_PASS=";

  const envContent = `# Kowloon — generated by installer on ${new Date().toISOString()}
# You can edit this file to change settings, then restart with: docker compose restart

NODE_ENV=production
PORT=3000

# ── Identity ──────────────────────────────────────────────────────────────────
DOMAIN=${cleanDomain}
SITE_TITLE=${cleanTitle}

# ── Admin account (used on first boot only; safe to remove after setup) ───────
ADMIN_EMAIL=${adminEmail.trim()}
ADMIN_USERNAME=${cleanUser}
ADMIN_DISPLAY_NAME=${displayName}
ADMIN_PASSWORD=${adminPassword}

# ── Database ──────────────────────────────────────────────────────────────────
MONGO_URI=mongodb://mongo:27017/kowloon

# ── Security ──────────────────────────────────────────────────────────────────
JWT_SECRET=${jwtSecret}

# ── File storage ──────────────────────────────────────────────────────────────
# Internal MinIO (S3-compatible). Files are private and stream through the app
# at /files/:id — there is no public storage endpoint to expose or secure.
S3_ENDPOINT=http://minio:9000
S3_BUCKET=kowloon
S3_REGION=us-east-1
S3_ACCESS_KEY=${s3AccessKey}
S3_SECRET_KEY=${s3SecretKey}

# ── Email (optional — notifications won't send without this) ──────────────────
${smtpLines}
`;

  // ── Shared services snippet (workers + minio + mongo) ──────────────────────
  const sharedServices = `
  # ── Background workers ───────────────────────────────────────────────────────
  worker-outbox:
    image: ghcr.io/jzellis/kowloon:latest
    restart: unless-stopped
    command: node workers/outboxPush.js
    env_file: .env
    depends_on:
      mongo:
        condition: service_healthy
    networks:
      - internal

  worker-pull:
    image: ghcr.io/jzellis/kowloon:latest
    restart: unless-stopped
    command: node workers/federationPull.js
    env_file: .env
    depends_on:
      mongo:
        condition: service_healthy
    networks:
      - internal

  worker-media:
    image: ghcr.io/jzellis/kowloon:latest
    restart: unless-stopped
    command: node workers/mediaProcessor.js
    env_file: .env
    depends_on:
      mongo:
        condition: service_healthy
      minio:
        condition: service_healthy
    networks:
      - internal

  worker-backup:
    image: ghcr.io/jzellis/kowloon:latest
    restart: unless-stopped
    command: node workers/backup.js
    env_file: .env
    depends_on:
      mongo:
        condition: service_healthy
      minio:
        condition: service_healthy
    networks:
      - internal

  # ── Object storage (internal only — files stream through the app) ────────────
  minio:
    image: minio/minio:latest
    restart: unless-stopped
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: "\${S3_ACCESS_KEY}"
      MINIO_ROOT_PASSWORD: "\${S3_SECRET_KEY}"
    volumes:
      - minio_data:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - internal

  # ── Create the storage bucket once, then exit ────────────────────────────────
  minio-init:
    image: minio/mc:latest
    depends_on:
      minio:
        condition: service_healthy
    entrypoint: >
      /bin/sh -c "
        mc alias set local http://minio:9000 \${S3_ACCESS_KEY} \${S3_SECRET_KEY} &&
        mc mb --ignore-existing local/kowloon &&
        mc anonymous set none local/kowloon &&
        echo 'MinIO bucket ready (private; served via the app proxy).'
      "
    restart: on-failure
    networks:
      - internal

  # ── Database ─────────────────────────────────────────────────────────────────
  mongo:
    image: mongo:7
    restart: unless-stopped
    volumes:
      - mongo_data:/data/db
    healthcheck:
      test: ["CMD", "mongosh", "--eval", "db.adminCommand('ping')"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - internal`;

  // ── Write Caddyfile (only when Caddy is managing TLS) ──────────────────────
  const caddyContent = `# Managed by Kowloon — do not edit directly.
# Caddy will automatically obtain a TLS certificate via Let's Encrypt.

{
    servers {
        timeouts {
            read_body 120s
        }
    }
}

${cleanDomain} {
    reverse_proxy app:3000 {
        transport http {
            read_timeout  120s
            write_timeout 120s
        }
    }
}
`;

  // ── Co-host: vhost snippet for the existing stack's Caddy + wiring guide ────
  const vhostBlock = `${cleanDomain} {
    reverse_proxy ${appAlias}:3000 {
        transport http {
            read_timeout  120s
            write_timeout 120s
        }
    }
}
`;

  const coHostReadme = `# Co-hosting ${cleanDomain} behind your existing Kowloon Caddy

This stack has no reverse proxy of its own and publishes no host ports. The
Caddy from the Kowloon server already running on this box will front
${cleanDomain} as well, over the shared "${edgeNet}" docker network. Mongo,
MinIO, and the workers stay private to this stack.

Run these once, on the box:

1. Create the shared edge network (safe to re-run):
     docker network create ${edgeNet} 2>/dev/null || true

2. Attach your EXISTING Kowloon stack's Caddy to it. In that stack's install
   dir (e.g. ~/kowloon), edit docker-compose.yml:
     - under the "caddy:" service, set:
         networks:
           - internal
           - edge
     - in the top-level "networks:" block at the bottom, add:
         edge:
           external: true
           name: ${edgeNet}

3. Append this block (also saved here as caddy-vhost.caddy) to that stack's
   Caddyfile:

${vhostBlock}
4. Recreate the existing stack's Caddy on the new network:
     cd ~/kowloon && docker compose up -d

5. Start THIS stack (from ${CONFIG_DIR} / this install dir):
     docker network create ${edgeNet} 2>/dev/null || true
     docker compose up -d

Once ${cleanDomain}'s DNS points at this box, Caddy fetches its Let's Encrypt
certificate automatically. Check with:  docker compose logs -f
`;

  // ── Write docker-compose.yml ────────────────────────────────────────────────
  const composeHeader = `# Kowloon — generated by installer on ${new Date().toISOString()}
# Manage with: docker compose up/down/restart/logs

services:`;

  // Co-host: no bundled Caddy, no host ports; the app joins the shared edge
  // network so the existing stack's Caddy can reach it.
  //
  // The app service is named "${appAlias}", NOT "app", on purpose. Docker gives
  // every service its name as a DNS alias on every network it joins. On the
  // shared edge network the existing stack's Caddy resolves "app" to reach its
  // OWN app — so a second service also named "app" would hijack that name and
  // the primary domain would start serving this stack. A unique service name
  // keeps "app" unambiguous for whoever owns it.
  const coHostCompose = `${composeHeader}

  # ── Application (includes web frontend) ─────────────────────────────────────
  # Co-host mode: fronted by the existing Kowloon stack's Caddy over "${edgeNet}".
  # Named "${appAlias}" (not "app") so it doesn't collide with the other stack's
  # "app" on the shared network. See COHOST-SETUP.md for the one-time wiring.
  ${appAlias}:
    image: ghcr.io/jzellis/kowloon:latest
    restart: unless-stopped
    env_file: .env
    depends_on:
      mongo:
        condition: service_healthy
      minio:
        condition: service_healthy
    volumes:
      - uploads:/app/uploads
    networks:
      - internal
      - edge
${sharedServices}

volumes:
  mongo_data:
  minio_data:
  uploads:

networks:
  internal:
    driver: bridge
  edge:
    external: true
    name: ${edgeNet}
`;

  const composeContent = isCoHost
    ? coHostCompose
    : selfManagedSsl
    ? `${composeHeader}

  # ── Application (includes web frontend) ─────────────────────────────────────
  app:
    image: ghcr.io/jzellis/kowloon:latest
    restart: unless-stopped
    env_file: .env
    ports:
      - "${port}:3000"
    depends_on:
      mongo:
        condition: service_healthy
      minio:
        condition: service_healthy
    volumes:
      - uploads:/app/uploads
    networks:
      - internal
${sharedServices}

volumes:
  mongo_data:
  minio_data:
  uploads:

networks:
  internal:
    driver: bridge
`
    : `${composeHeader}

  # ── Application (includes web frontend) ─────────────────────────────────────
  app:
    image: ghcr.io/jzellis/kowloon:latest
    restart: unless-stopped
    env_file: .env
    depends_on:
      mongo:
        condition: service_healthy
      minio:
        condition: service_healthy
    volumes:
      - uploads:/app/uploads
    networks:
      - internal
${sharedServices}

  # ── Reverse proxy + automatic TLS ────────────────────────────────────────────
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - app
    networks:
      - internal

volumes:
  mongo_data:
  minio_data:
  uploads:
  caddy_data:
  caddy_config:

networks:
  internal:
    driver: bridge
`;

  try {
    writeFileSync(join(CONFIG_DIR, ".env"),              envContent,     "utf8");
    if (isCoHost) {
      // No Caddyfile of our own; hand the operator a paste-ready vhost snippet,
      // a wiring guide, and a marker install.sh reads to create the edge network.
      writeFileSync(join(CONFIG_DIR, "caddy-vhost.caddy"), vhostBlock,   "utf8");
      writeFileSync(join(CONFIG_DIR, "COHOST-SETUP.md"),   coHostReadme, "utf8");
      writeFileSync(join(CONFIG_DIR, ".cohost-network"),   edgeNet + "\n", "utf8");
    } else if (!selfManagedSsl) {
      writeFileSync(join(CONFIG_DIR, "Caddyfile"),       caddyContent,   "utf8");
    }
    writeFileSync(join(CONFIG_DIR, "docker-compose.yml"),composeContent, "utf8");
  } catch (err) {
    console.error("Failed to write config files:", err.message);
    return res.status(500).json({ errors: ["Could not write config files: " + err.message] });
  }

  console.log(`Setup complete for ${cleanDomain}. Exiting so install.sh can start the stack.`);
  res.json({
    ok: true,
    domain: cleanDomain,
    selfManagedSsl,
    appPort: port,
    coHost: isCoHost,
    edgeNetwork: isCoHost ? edgeNet : undefined,
    appAlias: isCoHost ? appAlias : undefined,
  });

  // Give the response time to reach the browser before the process exits.
  setTimeout(() => process.exit(0), 1500);
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Kowloon installer ready on port ${PORT}`);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

let cachedPublicIp;

// The wizard runs in a container, so os.networkInterfaces() only sees the
// container bridge IP (172.17.x), not the host's public IP — which made the DNS
// check always report a mismatch. Resolve the real public IP instead: prefer
// the value install.sh already detected and passes through, then a public echo
// service (works from inside the container via NAT), then a local interface.
async function getPublicIp() {
  if (cachedPublicIp !== undefined) return cachedPublicIp;

  if (process.env.SERVER_IP?.trim()) {
    cachedPublicIp = process.env.SERVER_IP.trim();
    return cachedPublicIp;
  }

  for (const url of ["https://api.ipify.org", "https://icanhazip.com"]) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const resp = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (resp.ok) {
        const ip = (await resp.text()).trim();
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
          cachedPublicIp = ip;
          return ip;
        }
      }
    } catch {}
  }

  cachedPublicIp = getInterfaceIp();
  return cachedPublicIp;
}

function getInterfaceIp() {
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      if (name.startsWith("lo")) continue;
      for (const iface of ifaces[name]) {
        if (iface.family === "IPv4" && !iface.internal) return iface.address;
      }
    }
  } catch {}
  return null;
}
