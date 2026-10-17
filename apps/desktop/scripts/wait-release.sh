#!/usr/bin/env bash
# Wait for a desktop release to finish and prove it shipped.
#
#   bash apps/desktop/scripts/wait-release.sh [version]   (default: package.json version)
#
# Watches the Auto Release run for the `chore(release): v<version>` commit.
# release.yml runs nested via workflow_call, so `gh run list --workflow release.yml`
# only shows old manual dispatches. Polls `gh run view` instead of `gh run watch`,
# which exits 0 on a network blip. Then checks that the published release's
# latest-mac.yml reports the version. Exit 0 only when both hold.
set -euo pipefail

repo_root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
version="${1:-$(node -p "require('$repo_root/apps/desktop/package.json').version")}"
tag="v$version"
interval="${WAIT_RELEASE_INTERVAL:-20}"
deadline=$(( $(date +%s) + ${WAIT_RELEASE_TIMEOUT:-3600} ))

sha="$(git -C "$repo_root" log -1 --format=%H --fixed-strings --grep="chore(release): $tag" || true)"
if [ -z "$sha" ]; then
  sha="$(git -C "$repo_root" rev-parse HEAD)"
  echo "No 'chore(release): $tag' commit found; watching HEAD ${sha:0:7}." >&2
fi

past_deadline() { [ "$(date +%s)" -ge "$deadline" ]; }

run_id=""
while [ -z "$run_id" ]; do
  run_id="$(gh run list --workflow auto-release.yml --commit "$sha" --limit 1 \
    --json databaseId --jq '.[0].databaseId // empty' 2>/dev/null || true)"
  if [ -n "$run_id" ]; then break; fi
  if past_deadline; then echo "[FAIL] no Auto Release run for ${sha:0:7}" >&2; exit 1; fi
  sleep "$interval"
done
echo "Auto Release run $run_id for $tag (${sha:0:7})"

queued_since=""
while :; do
  # A failed gh call (wifi drop) is not a result: keep polling.
  if state="$(gh run view "$run_id" --json status,conclusion --jq '.status + " " + .conclusion' 2>/dev/null)"; then
    status="${state%% *}"
    conclusion="${state#* }"
    if [ "$status" = "completed" ]; then break; fi
    if [ "$status" = "queued" ]; then
      queued_since="${queued_since:-$(date +%s)}"
      if [ $(( $(date +%s) - queued_since )) -ge 600 ]; then
        echo "Queued 10+ min: the runner listener may be dead (cd ~/actions-runner && ./svc.sh stop && ./svc.sh start)." >&2
        queued_since="$(date +%s)"
      fi
    else
      queued_since=""
    fi
  fi
  if past_deadline; then echo "[FAIL] timed out waiting on run $run_id ($status)" >&2; exit 1; fi
  sleep "$interval"
done

if [ "$conclusion" != "success" ]; then
  echo "[FAIL] run $run_id concluded '$conclusion'. Failed jobs:" >&2
  gh run view "$run_id" --json jobs \
    --jq '.jobs[] | select(.conclusion != "success" and .conclusion != "skipped") | "  " + .name + ": " + .conclusion' >&2 || true
  echo "Logs: gh run view $run_id --log-failed   Retry: gh run rerun $run_id --failed" >&2
  exit 1
fi

if [ "$(gh release view "$tag" --json isDraft --jq .isDraft)" != "false" ]; then
  echo "[FAIL] $tag is not a published release" >&2
  exit 1
fi
reported="$(gh release download "$tag" --pattern latest-mac.yml --output - | sed -n 's/^version: *//p')"
if [ "$reported" != "$version" ]; then
  echo "[FAIL] $tag latest-mac.yml reports version '$reported'" >&2
  exit 1
fi
echo "[OK] $tag published; latest-mac.yml reports $version"
