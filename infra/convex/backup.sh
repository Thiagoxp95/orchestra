#!/usr/bin/env bash
# Logical backup of the self-hosted Convex deployment.
#
# Two layers protect this data, and they fail differently:
#
#   1. Fly volume snapshots — automatic, daily, 5-day retention, already on.
#      Block-level, so they restore the whole machine but only within Fly and
#      only for 5 days.
#   2. This script — a portable snapshot zip, restorable into *any* Convex
#      deployment (self-hosted or cloud) with `convex import`. This is the one
#      that survives losing the Fly account, and the one to run before a schema
#      change or anything else you might need to undo.
#
# Convex Cloud used to do both for us; self-hosted does not, which is the one
# real thing we gave up by moving.
#
# Usage:  infra/convex/backup.sh [output-dir]     (default: ./convex-backups)
# Restore: cd apps/backend && bunx convex import --replace-all <file>.zip

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/apps/backend"
OUT_DIR="${1:-$REPO_ROOT/convex-backups}"

# Credentials live in apps/backend/.env.local (gitignored); the convex CLI
# reads them itself when run from that directory.
if [ ! -f "$BACKEND_DIR/.env.local" ]; then
  echo "error: $BACKEND_DIR/.env.local not found — no deployment credentials." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$OUT_DIR/orchestra-$STAMP.zip"

cd "$BACKEND_DIR"
bunx convex export --path "$OUT"

echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"

# Keep the 10 most recent. These are ~1MB each — ptyChunks and agentMessages are
# the bulk, and the prune cron keeps them bounded.
ls -1t "$OUT_DIR"/orchestra-*.zip 2>/dev/null | tail -n +11 | while read -r old; do
  echo "pruning $old"
  rm -f "$old"
done
