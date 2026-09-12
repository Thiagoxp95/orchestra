#!/usr/bin/env bash
# Logical backup of the self-hosted Convex deployment.
#
# Portable backups contain current documents and stored files, and can be
# restored with `convex import`. The local daily wrapper additionally saves
# environment settings and instance credentials outside the checkout.
# Keep an independent copy to protect against losing the Mac.
#
# Usage:  infra/convex/backup.sh [output-dir]     (default: ./convex-backups)
# Restore: cd apps/backend && bunx convex import --replace-all <file>.zip

set -euo pipefail
umask 077

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
bunx convex export --include-file-storage --path "$OUT"
chmod 600 "$OUT"

echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"

# Keep the 10 most recent completed exports; terminal history can make these large.
ls -1t "$OUT_DIR"/orchestra-*.zip 2>/dev/null | tail -n +11 | while read -r old; do
  echo "pruning $old"
  rm -f "$old"
done
