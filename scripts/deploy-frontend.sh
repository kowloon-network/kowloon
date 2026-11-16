#!/usr/bin/env bash
# deploy-frontend.sh
#
# Trigger a GitHub Actions rebuild of the Kowloon Docker image (which bundles
# the frontend) and redeploy the running container when it succeeds.
#
# Requirements:
#   - curl, jq  (standard on any Linux server)
#   - GITHUB_TOKEN with "repo" and "workflow" scopes
#     Set it as an env var, or add GITHUB_TOKEN=... to the .env file in
#     the same directory as your docker-compose.yml.
#
# Usage:
#   ./deploy-frontend.sh                    # uses COMPOSE_DIR=$(pwd)
#   COMPOSE_DIR=/opt/kowloon ./deploy-frontend.sh
#   GITHUB_TOKEN=ghp_... ./deploy-frontend.sh

set -euo pipefail

# ── Configuration (override via environment) ─────────────────────────────────
REPO="${GH_REPO:-kowloon-network/kowloon}"
WORKFLOW="${GH_WORKFLOW:-docker.yml}"
BRANCH="${GH_BRANCH:-main}"
COMPOSE_DIR="${COMPOSE_DIR:-$(pwd)}"
POLL_INTERVAL="${POLL_INTERVAL:-30}"   # seconds between status checks
TIMEOUT_MINUTES="${TIMEOUT_MINUTES:-20}"

# ── Load token ────────────────────────────────────────────────────────────────
if [ -z "${GITHUB_TOKEN:-}" ]; then
  ENV_FILE="$COMPOSE_DIR/.env"
  if [ -f "$ENV_FILE" ]; then
    GITHUB_TOKEN=$(grep -m1 '^GITHUB_TOKEN=' "$ENV_FILE" 2>/dev/null \
      | cut -d= -f2- | tr -d '"' || true)
  fi
fi

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "Error: GITHUB_TOKEN is not set."
  echo "  Export it:  export GITHUB_TOKEN=ghp_..."
  echo "  Or add it:  echo 'GITHUB_TOKEN=ghp_...' >> $COMPOSE_DIR/.env"
  exit 1
fi

# ── Helpers ───────────────────────────────────────────────────────────────────
gh_api() {
  local method="$1" url="$2"; shift 2
  curl -sf -X "$method" \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$@" "$url"
}

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
info()  { printf '    %s\n' "$*"; }
ok()    { printf '\033[32m  + %s\033[0m\n' "$*"; }
fail()  { printf '\033[31m  ! %s\033[0m\n' "$*" >&2; }

# ── 1. Trigger workflow_dispatch ──────────────────────────────────────────────
bold "==> Triggering rebuild on $REPO ($BRANCH)..."

# Record time before dispatch so we can identify our run vs. pre-existing ones
BEFORE_TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

gh_api POST \
  "https://api.github.com/repos/$REPO/actions/workflows/$WORKFLOW/dispatches" \
  -H "Content-Type: application/json" \
  -d "{\"ref\":\"$BRANCH\"}" \
  || { fail "Dispatch failed. Confirm GITHUB_TOKEN has 'workflow' scope."; exit 1; }

info "Dispatch accepted. Waiting for run to appear in the queue..."
sleep 10

# ── 2. Find the run we just created ──────────────────────────────────────────
RUN_ID=""
for attempt in 1 2 3 4 5; do
  RUN_JSON=$(gh_api GET \
    "https://api.github.com/repos/$REPO/actions/workflows/$WORKFLOW/runs?branch=$BRANCH&event=workflow_dispatch&per_page=5")

  RUN_ID=$(echo "$RUN_JSON" | jq -r \
    --arg ts "$BEFORE_TS" \
    '[.workflow_runs[] | select(.created_at >= $ts)] | first | .id // empty')

  [ -n "$RUN_ID" ] && break
  info "Not visible yet — retrying in 5s... ($attempt/5)"
  sleep 5
done

if [ -z "$RUN_ID" ]; then
  fail "Could not locate the triggered run. Check GitHub Actions manually:"
  fail "  https://github.com/$REPO/actions"
  exit 1
fi

ok "Run ID: $RUN_ID"
info "Live log: https://github.com/$REPO/actions/runs/$RUN_ID"

# ── 3. Poll until complete ────────────────────────────────────────────────────
bold "==> Waiting for build to finish (timeout: ${TIMEOUT_MINUTES}m)..."

DEADLINE=$(( $(date +%s) + TIMEOUT_MINUTES * 60 ))
SPIN=0

while true; do
  if [ "$(date +%s)" -gt "$DEADLINE" ]; then
    echo ""
    fail "Timed out after ${TIMEOUT_MINUTES} minutes."
    fail "Check: https://github.com/$REPO/actions/runs/$RUN_ID"
    exit 1
  fi

  RUN=$(gh_api GET "https://api.github.com/repos/$REPO/actions/runs/$RUN_ID")
  STATUS=$(echo "$RUN" | jq -r '.status')
  CONCLUSION=$(echo "$RUN" | jq -r '.conclusion // empty')

  if [ "$STATUS" = "completed" ]; then
    echo ""
    if [ "$CONCLUSION" = "success" ]; then
      ok "Build succeeded."
      break
    else
      fail "Build $CONCLUSION."
      fail "See: https://github.com/$REPO/actions/runs/$RUN_ID"
      exit 1
    fi
  fi

  SPIN=$(( (SPIN + 1) % 4 ))
  SPINNER=('-' '\' '|' '/')
  printf "\r    %-16s %s  " "$STATUS" "${SPINNER[$SPIN]}"
  sleep "$POLL_INTERVAL"
done

# ── 4. Pull new image and restart ─────────────────────────────────────────────
bold "==> Pulling new image..."
cd "$COMPOSE_DIR"
docker compose pull app

bold "==> Restarting container..."
docker compose up -d app

echo ""
ok "Done! The latest frontend is live."
