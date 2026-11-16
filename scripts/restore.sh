#!/usr/bin/env bash
# Kowloon restore — imports a backup archive created by scripts/backup.sh.
#
# Run from the directory containing docker-compose.yml and .env:
#   bash scripts/restore.sh <path-to-backup.tar.gz>
#
# WARNING: This replaces ALL data on the current installation.
# Run this immediately after a fresh install, before adding any new data.
#
# The restore uses the CURRENT installation's S3 credentials (.env), not
# the backed-up credentials — so files upload to the new MinIO correctly.
# Sign-in keys live in the database, so members stay signed in after a restore.

set -euo pipefail

# ── Helpers ───────────────────────────────────────────────────────────────────

info()  { echo "  [restore] $*"; }
ok()    { echo "  [restore] ✓ $*"; }
warn()  { echo "  [restore] WARNING: $*"; }
die()   { echo "  [restore] ERROR: $*" >&2; exit 1; }

# ── Args ──────────────────────────────────────────────────────────────────────

ARCHIVE="${1:-}"
[[ -n "$ARCHIVE" ]] || die "Usage: bash scripts/restore.sh <path-to-backup.tar.gz>"
[[ -f "$ARCHIVE" ]] || die "Archive not found: $ARCHIVE"

# Resolve to absolute path before any cd
ARCHIVE="$(cd "$(dirname "$ARCHIVE")" && pwd)/$(basename "$ARCHIVE")"

# ── Locate compose directory ──────────────────────────────────────────────────

COMPOSE_DIR="${COMPOSE_DIR:-$PWD}"
ENV_FILE="$COMPOSE_DIR/.env"
COMPOSE_FILE="$COMPOSE_DIR/docker-compose.yml"

[[ -f "$COMPOSE_FILE" ]] || die "docker-compose.yml not found in $COMPOSE_DIR — run this script from your Kowloon install directory."
[[ -f "$ENV_FILE" ]]     || die ".env not found in $COMPOSE_DIR"

# ── Read current installation's credentials ───────────────────────────────────

S3_ACCESS_KEY=$(grep -E '^S3_ACCESS_KEY=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")
S3_SECRET_KEY=$(grep -E '^S3_SECRET_KEY=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")
S3_BUCKET=$(grep -E '^S3_BUCKET=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")
MONGO_URI=$(grep -E '^MONGO_URI=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")

[[ -n "$S3_ACCESS_KEY" ]] || die "S3_ACCESS_KEY not found in .env"
[[ -n "$S3_SECRET_KEY" ]] || die "S3_SECRET_KEY not found in .env"
[[ -n "$S3_BUCKET" ]]     || die "S3_BUCKET not found in .env"
[[ -n "$MONGO_URI" ]]     || die "MONGO_URI not found in .env"

DB_NAME=$(echo "$MONGO_URI" | sed 's|.*/||' | cut -d'?' -f1)
[[ -n "$DB_NAME" ]] || die "Could not parse database name from MONGO_URI"

# ── Extract and validate archive ──────────────────────────────────────────────

TMPDIR_WORK=$(mktemp -d)
trap 'rm -rf "$TMPDIR_WORK"' EXIT

info "Extracting archive..."
tar -xzf "$ARCHIVE" -C "$TMPDIR_WORK"

[[ -f "$TMPDIR_WORK/manifest.json" ]] || die "Archive is missing manifest.json — is this a valid Kowloon backup?"
[[ -f "$TMPDIR_WORK/db.archive" ]]    || die "Archive is missing db.archive."
[[ -d "$TMPDIR_WORK/files" ]]         || die "Archive is missing files directory."

BACKUP_DB=$(python3 -c "import json,sys; d=json.load(open('$TMPDIR_WORK/manifest.json')); print(d['database'])" 2>/dev/null \
  || grep -o '"database":"[^"]*"' "$TMPDIR_WORK/manifest.json" | cut -d'"' -f4)
BACKUP_FILES=$(python3 -c "import json,sys; d=json.load(open('$TMPDIR_WORK/manifest.json')); print(d['fileCount'])" 2>/dev/null \
  || grep -o '"fileCount":[0-9]*' "$TMPDIR_WORK/manifest.json" | cut -d: -f2)
BACKUP_DATE=$(python3 -c "import json,sys; d=json.load(open('$TMPDIR_WORK/manifest.json')); print(d['createdAt'])" 2>/dev/null \
  || grep -o '"createdAt":"[^"]*"' "$TMPDIR_WORK/manifest.json" | cut -d'"' -f4)

ok "Archive validated"

# ── Confirm ───────────────────────────────────────────────────────────────────

echo
echo "  ┌─────────────────────────────────────────────────────┐"
echo "  │  KOWLOON RESTORE                                    │"
echo "  │                                                     │"
printf "  │  Backup date:   %-35s│\n" "$BACKUP_DATE"
printf "  │  Source DB:     %-35s│\n" "$BACKUP_DB"
printf "  │  Files:         %-35s│\n" "$BACKUP_FILES"
echo "  │                                                     │"
echo "  │  Target DB:     $DB_NAME"
echo "  │  Target bucket: $S3_BUCKET"
echo "  │                                                     │"
echo "  │  WARNING: This will REPLACE all current data.      │"
echo "  └─────────────────────────────────────────────────────┘"
echo
read -r -p "  Type YES to proceed: " CONFIRM
[[ "$CONFIRM" == "YES" ]] || { info "Aborted."; exit 0; }
echo

# ── Stop app containers (keep mongo + minio running) ──────────────────────────

info "Stopping application containers..."

# Build list of services to stop — everything except mongo and minio
APP_SERVICES=$(cd "$COMPOSE_DIR" && docker compose config --services \
  | grep -Ev '^(mongo|mongodb|minio|minio-init|caddy)$' || true)

if [[ -n "$APP_SERVICES" ]]; then
  (cd "$COMPOSE_DIR" && echo "$APP_SERVICES" | xargs docker compose stop 2>/dev/null || true)
  ok "Application containers stopped"
else
  warn "No app containers found to stop — continuing anyway"
fi

# ── Step 1: MongoDB restore ───────────────────────────────────────────────────

info "Restoring MongoDB database '$DB_NAME'..."

(cd "$COMPOSE_DIR" && docker compose exec -T mongo \
  mongorestore \
    --db="$DB_NAME" \
    --archive \
    --gzip \
    --drop \
    --quiet \
) < "$TMPDIR_WORK/db.archive"

ok "Database restored"

# ── Step 2: MinIO file restore ────────────────────────────────────────────────

info "Uploading files to MinIO bucket '$S3_BUCKET'..."

MINIO_CONTAINER=$(cd "$COMPOSE_DIR" && docker compose ps -q minio 2>/dev/null | head -1)
[[ -n "$MINIO_CONTAINER" ]] || die "minio container is not running."

MC_NETWORK=$(docker inspect "$MINIO_CONTAINER" \
  --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' \
  | tr ' ' '\n' | grep -v '^$' | head -1)

[[ -n "$MC_NETWORK" ]] || die "Could not detect minio container network."

docker run --rm \
  --network "$MC_NETWORK" \
  --volume "$TMPDIR_WORK/files:/import:ro" \
  --entrypoint /bin/sh \
  minio/mc:latest -c "
    mc alias set dst http://minio:9000 '$S3_ACCESS_KEY' '$S3_SECRET_KEY' --api S3v4 >/dev/null 2>&1 &&
    mc mirror --preserve --overwrite /import/ dst/'$S3_BUCKET'/
  "

RESTORED_FILES=$(find "$TMPDIR_WORK/files" -type f | wc -l | tr -d ' ')
ok "Uploaded $RESTORED_FILES files to bucket"

# ── Step 3: Restart app containers ───────────────────────────────────────────

info "Restarting application containers..."

(cd "$COMPOSE_DIR" && docker compose up -d)

ok "All containers started"

echo
echo "  Restore complete."
echo
echo "  Members' sign-ins carry over: the signing keys are restored with the"
echo "  database. Restart the stack (docker compose up -d) if it was running."
