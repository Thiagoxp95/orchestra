import * as fs from 'node:fs'
import * as path from 'node:path'
import { getOrchestraHomeDir } from './orchestra-paths'
import { buildShellPath, type NodeRuntimeContext } from './node-runtime'

export const GIT_SIGNING_GUARD_SCRIPT_NAME = 'git'

const GIT_SIGNING_GUARD_SCRIPT = `#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

find_real_git() {
  old_ifs=$IFS
  IFS=:
  for dir in $PATH; do
    IFS=$old_ifs
    [ -z "$dir" ] && continue
    dir=\${dir%/}
    [ "$dir" = "$SCRIPT_DIR" ] && continue
    if [ -x "$dir/git" ] && [ ! -d "$dir/git" ]; then
      printf '%s\\n' "$dir/git"
      return 0
    fi
    IFS=:
  done
  IFS=$old_ifs
  return 1
}

REAL_GIT=$(find_real_git || true)
if [ -z "$REAL_GIT" ]; then
  echo "Orchestra: real git not found in PATH." >&2
  exit 127
fi

has_signing_arg() {
  for arg in "$@"; do
    case "$arg" in
      --no-gpg-sign|--no-gpg-sign=*)
        echo "Orchestra: refusing to create an unsigned commit (--no-gpg-sign)." >&2
        exit 1
        ;;
      -S|--gpg-sign|--gpg-sign=*|-S?*)
        return 0
        ;;
    esac
  done
  return 1
}

has_control_flow_arg() {
  for arg in "$@"; do
    case "$arg" in
      --abort|--continue|--quit|--skip)
        return 0
        ;;
    esac
  done
  return 1
}

exec_with_signing() {
  command_name=$1
  shift
  if has_control_flow_arg "$@"; then
    exec "$REAL_GIT" "$command_name" "$@"
  fi
  if has_signing_arg "$@"; then
    exec "$REAL_GIT" "$command_name" "$@"
  fi
  exec "$REAL_GIT" "$command_name" -S "$@"
}

verify_unpushed_commits_are_signed() {
  "$REAL_GIT" rev-parse --git-dir >/dev/null 2>&1 || return 0
  commits=$("$REAL_GIT" rev-list HEAD --not --remotes 2>/dev/null || true)
  [ -n "$commits" ] || return 0

  missing=0
  for commit in $commits; do
    if ! "$REAL_GIT" cat-file -p "$commit" | grep -q '^gpgsig '; then
      if [ "$missing" -eq 0 ]; then
        echo "Orchestra: refusing to push unsigned commits:" >&2
      fi
      subject=$("$REAL_GIT" log -1 --format=%s "$commit" 2>/dev/null || true)
      echo "  $commit $subject" >&2
      missing=1
    fi
  done

  if [ "$missing" -ne 0 ]; then
    echo "Create or amend commits with signing enabled before pushing." >&2
    exit 1
  fi
}

case "\${1:-}" in
  commit|commit-tree|merge|cherry-pick|revert|rebase)
    command_name=$1
    shift
    exec_with_signing "$command_name" "$@"
    ;;
  push)
    verify_unpushed_commits_are_signed
    exec "$REAL_GIT" "$@"
    ;;
  *)
    exec "$REAL_GIT" "$@"
    ;;
esac
`

export function getGitSigningGuardDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getOrchestraHomeDir(env), 'git-guard')
}

export function prependPathEntry(pathValue: string | undefined, entry: string, platform: NodeJS.Platform = process.platform): string {
  const delimiter = platform === 'win32' ? ';' : ':'
  const entries = (pathValue || '')
    .split(delimiter)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => part !== entry)
  return [entry, ...entries].join(delimiter)
}

export function ensureGitSigningGuardScript(env: NodeJS.ProcessEnv = process.env): { path: string; changed: boolean } {
  const dir = getGitSigningGuardDir(env)
  const scriptPath = path.join(dir, GIT_SIGNING_GUARD_SCRIPT_NAME)
  fs.mkdirSync(dir, { recursive: true })

  const previous = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : null
  if (previous === GIT_SIGNING_GUARD_SCRIPT) {
    return { path: scriptPath, changed: false }
  }

  fs.writeFileSync(scriptPath, GIT_SIGNING_GUARD_SCRIPT, { mode: 0o755 })
  return { path: scriptPath, changed: true }
}

export function buildGitSigningGuardEnv(
  baseEnv: Record<string, string> = {},
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const mergedEnv = { ...env, ...baseEnv }
  const guardDir = getGitSigningGuardDir(mergedEnv)
  const pathContext: NodeRuntimeContext = {
    execPath: process.execPath,
    env: mergedEnv,
    versions: process.versions,
    platform,
  }
  return {
    ...baseEnv,
    ORCHESTRA_GIT_SIGNING_GUARD: '1',
    PATH: prependPathEntry(buildShellPath(pathContext), guardDir, platform),
  }
}
