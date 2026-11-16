#!/usr/bin/env bash
# Kowloon installer
# Usage: curl -fsSL https://raw.githubusercontent.com/kowloon-network/kowloon/main/install.sh | bash
# Or run directly: bash install.sh [install-dir]
#
# install-dir   Where Kowloon config files are written (default: ~/kowloon).
#               Can also be set via KOWLOON_DIR env var.
#               Example: curl ... | bash -s -- /opt/kowloon

set -euo pipefail

# Which release to install. "stable" is the newest release; set
# KOWLOON_VERSION=0.9.0 (say) for a specific one, or "latest" for the
# untested main branch. The wizard pins the server to that exact version.
KOWLOON_VERSION="${KOWLOON_VERSION:-stable}"
SETUP_IMAGE="ghcr.io/kowloon-network/kowloon-setup:${KOWLOON_VERSION}"
INSTALL_DIR="${1:-${KOWLOON_DIR:-$HOME/kowloon}}"
SETUP_PORT=2999

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
RESET='\033[0m'

info()    { echo -e "${BOLD}==> $*${RESET}"; }
success() { echo -e "${GREEN}==> $*${RESET}"; }
warn()    { echo -e "${YELLOW}==> WARNING: $*${RESET}"; }
error()   { echo -e "${RED}==> ERROR: $*${RESET}" >&2; exit 1; }

# ── Check Docker ──────────────────────────────────────────────────────────────
info "Checking requirements..."

if ! command -v docker &>/dev/null; then
  if command -v apt-get &>/dev/null && ( [[ -f /etc/debian_version ]] || grep -qi "debian\|ubuntu" /etc/os-release 2>/dev/null ); then
    info "Docker not found. Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    if ! command -v docker &>/dev/null; then
      error "Docker installation failed. Install it manually from https://docs.docker.com/get-docker/ and re-run the installer."
    fi
    success "Docker installed."
  else
    warn "Docker is not installed."
    echo ""
    echo "  Install Docker from: https://docs.docker.com/get-docker/"
    echo "  Then re-run this installer."
    echo ""
    exit 1
  fi
fi

if ! docker info &>/dev/null; then
  if sudo docker info &>/dev/null; then
    warn "Docker requires sudo on this system. Re-run the installer with: sudo -E bash install.sh"
    warn "Or add your user to the docker group: sudo usermod -aG docker \$USER && newgrp docker"
    exit 1
  fi
  error "Docker is installed but not running. Start Docker and try again."
fi

DOCKER_VERSION=$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo "unknown")
info "Docker $DOCKER_VERSION found."

# Compose v2 check
if ! docker compose version &>/dev/null; then
  error "Docker Compose v2 is required (docker compose, not docker-compose).\nInstall it from: https://docs.docker.com/compose/install/"
fi

# ── Working directory ─────────────────────────────────────────────────────────
info "Setting up install directory: $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# ── Guard: never clobber an existing Kowloon stack ────────────────────────────
# Installing into a directory that already holds a Kowloon install would
# overwrite its config and, on `docker compose up`, could disrupt that running
# server. A second server on the same box MUST use its own directory (that's how
# its Mongo/MinIO volumes stay separate). Refuse and point the way out.
if [[ -f "$INSTALL_DIR/.env" || -f "$INSTALL_DIR/docker-compose.yml" ]]; then
  EXISTING_DOMAIN=$(grep '^DOMAIN=' "$INSTALL_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')
  echo ""
  error "This directory already contains a Kowloon install${EXISTING_DOMAIN:+ for ${EXISTING_DOMAIN}}: $INSTALL_DIR
  Installing here would overwrite it and could disrupt that server (and its data).

  To add a SECOND server on this box, install into a NEW directory instead:
      KOWLOON_DIR=\$HOME/kowloon-<name> bash install.sh
    or:
      bash install.sh \$HOME/kowloon-<name>

  To intentionally reconfigure THIS install, remove its .env first:  rm $INSTALL_DIR/.env"
fi

# ── Get server IP ─────────────────────────────────────────────────────────────
SERVER_IP=""
# Try common sources in order
for iface_ip in \
  "$(curl -sf --max-time 3 https://api.ipify.org 2>/dev/null)" \
  "$(curl -sf --max-time 3 https://icanhazip.com 2>/dev/null)" \
  "$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}')"; do
  if [[ -n "$iface_ip" ]]; then
    SERVER_IP="$iface_ip"
    break
  fi
done

echo ""
echo -e "${BOLD}Your server's public IP address is: ${GREEN}${SERVER_IP:-unknown}${RESET}"
echo "Make sure your domain's A record points to this IP before continuing."
echo ""

# ── Pull setup image ──────────────────────────────────────────────────────────
info "Pulling Kowloon setup image..."
docker pull "$SETUP_IMAGE"

# ── Run setup container ───────────────────────────────────────────────────────
info "Starting installation wizard..."
echo ""
echo -e "  Open this URL in your browser: ${BOLD}http://${SERVER_IP:-<your-server-ip>}:${SETUP_PORT}${RESET}"
echo ""
echo "  (If running locally, use: http://localhost:${SETUP_PORT})"
echo ""
echo "  The installer will guide you through the rest of the setup."
echo "  This terminal will wait until you complete the form..."
echo ""

# Run in foreground — blocks until setup server calls process.exit(0).
# The /config volume is mounted to our INSTALL_DIR so generated files land here.
# Clear any leftover setup container from a previous or cancelled run so the
# name isn't already taken.
docker rm -f kowloon-setup &>/dev/null || true
docker run --rm \
  --name kowloon-setup \
  -p "${SETUP_PORT}:${SETUP_PORT}" \
  -v "${INSTALL_DIR}:/config" \
  -e SERVER_IP="${SERVER_IP}" \
  "$SETUP_IMAGE"

# ── Verify config was written ─────────────────────────────────────────────────
if [[ ! -f "$INSTALL_DIR/.env" ]]; then
  error "Setup did not complete — .env was not created. Run the installer again."
fi

if [[ ! -f "$INSTALL_DIR/docker-compose.yml" ]]; then
  error "Setup did not complete — docker-compose.yml was not created. Run the installer again."
fi

success "Configuration written to $INSTALL_DIR"

# ── Pull app images ───────────────────────────────────────────────────────────
info "Pulling Kowloon app images (this may take a minute)..."
docker compose pull

# ── Co-host: ensure the shared edge network exists ────────────────────────────
# When this box already runs another Kowloon server, the setup wizard writes a
# .cohost-network marker naming the external docker network both stacks share.
# The compose file references it as external, so it must exist before `up`.
COHOST_NET=""
if [[ -f "$INSTALL_DIR/.cohost-network" ]]; then
  COHOST_NET=$(tr -d '[:space:]' < "$INSTALL_DIR/.cohost-network")
  if [[ -n "$COHOST_NET" ]]; then
    info "Co-host mode: ensuring shared network '$COHOST_NET' exists..."
    docker network create "$COHOST_NET" &>/dev/null || true
  fi
fi

# ── Start the stack ───────────────────────────────────────────────────────────
info "Starting Kowloon..."
docker compose up -d

# ── Wait for health ───────────────────────────────────────────────────────────
DOMAIN=$(grep '^DOMAIN=' "$INSTALL_DIR/.env" | cut -d= -f2 | tr -d '[:space:]')

# Co-host installs aren't reachable over HTTPS yet — the existing server's Caddy
# has to be wired to this domain first (COHOST-SETUP.md). Skip the health poll
# and print the hand-off instead of a false "not responding" warning.
if [[ -n "$COHOST_NET" ]]; then
  echo ""
  echo -e "${GREEN}${BOLD}============================================================${RESET}"
  echo -e "${GREEN}${BOLD}  ${DOMAIN} is running — one wiring step left${RESET}"
  echo -e "${GREEN}${BOLD}============================================================${RESET}"
  echo ""
  echo "  This stack has no proxy of its own. Finish co-hosting by wiring the"
  echo "  existing Kowloon server's Caddy to ${DOMAIN}:"
  echo ""
  echo -e "    ${BOLD}cat $INSTALL_DIR/COHOST-SETUP.md${RESET}"
  echo ""
  echo "  In short: add the block from $INSTALL_DIR/caddy-vhost.caddy to the other"
  echo "  stack's Caddyfile, join its caddy service to the '$COHOST_NET' network,"
  echo "  then 'docker compose up -d' that stack. TLS is then automatic."
  echo ""
  echo "  Logs for this stack:  (cd $INSTALL_DIR && docker compose logs -f)"
  echo ""
  exit 0
fi

info "Waiting for Kowloon to become available..."

MAX_WAIT=120
WAITED=0
HEALTH_URL="https://${DOMAIN}/health"

while true; do
  STATUS=$(curl -sfk --max-time 5 "$HEALTH_URL" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print('ok' if d.get('ok') or d.get('status')=='ok' else 'wait')" 2>/dev/null || echo "wait")
  if [[ "$STATUS" == "ok" ]]; then
    break
  fi
  if [[ $WAITED -ge $MAX_WAIT ]]; then
    warn "Kowloon is not responding at $HEALTH_URL after ${MAX_WAIT}s."
    warn "It may still be starting. Check status with: docker compose logs -f"
    break
  fi
  sleep 5
  WAITED=$((WAITED + 5))
  echo -n "."
done
echo ""

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}============================================================${RESET}"
echo -e "${GREEN}${BOLD}  Kowloon is installed!${RESET}"
echo -e "${GREEN}${BOLD}============================================================${RESET}"
echo ""
echo -e "  Your server: ${BOLD}https://${DOMAIN}${RESET}"
echo ""
echo "  Useful commands (run from $INSTALL_DIR):"
echo "    docker compose logs -f       # follow logs"
echo "    docker compose restart       # restart all services"
echo "    docker compose down          # stop"
echo "    docker compose pull && docker compose up -d  # upgrade"
echo ""
