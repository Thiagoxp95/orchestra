import * as fs from 'node:fs'
import * as path from 'node:path'
import { getOrchestraHomeDir } from './orchestra-paths'
import { buildShellPath, type NodeRuntimeContext } from './node-runtime'

export const GIT_SIGNING_GUARD_SCRIPT_NAME = 'git'

const GIT_SIGNING_GUARD_SCRIPT = `#!/bin/bash
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

refuse_unsigned_config() {
  setting=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  case "$setting" in
    commit.gpgsign|commit.gpgsign=true|commit.gpgsign=yes|commit.gpgsign=on|commit.gpgsign=1) ;;
    commit.gpgsign=*)
      echo "Orchestra: refusing to disable commit signing (-c $1). If signing fails, fix signing; don't skip it." >&2
      exit 1
      ;;
  esac
}

# Global options (-C, -c, --git-dir, ...) come before the subcommand. Keep them
# so the guard finds the real subcommand and its own git calls see the same repo.
globals=()
while [ $# -gt 0 ]; do
  case "$1" in
    -c)
      [ $# -ge 2 ] || break
      refuse_unsigned_config "$2"
      globals+=("$1" "$2")
      shift 2
      ;;
    -C|--git-dir|--work-tree|--namespace|--config-env|--super-prefix)
      [ $# -ge 2 ] || break
      globals+=("$1" "$2")
      shift 2
      ;;
    -*)
      globals+=("$1")
      shift
      ;;
    *)
      break
      ;;
  esac
done

git_real() {
  "$REAL_GIT" \${globals[@]+"\${globals[@]}"} "$@"
}

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
      --abort|--continue|--quit|--skip|--edit-todo|--show-current-patch|--resolved)
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
    exec "$REAL_GIT" \${globals[@]+"\${globals[@]}"} "$command_name" "$@"
  fi
  if has_signing_arg "$@"; then
    exec "$REAL_GIT" \${globals[@]+"\${globals[@]}"} "$command_name" "$@"
  fi
  exec "$REAL_GIT" \${globals[@]+"\${globals[@]}"} "$command_name" -S "$@"
}

# The revs a push sends: each refspec's source, --all's branches, or HEAD when
# no refspec is given. Checking only HEAD let a named branch through unsigned.
push_revs() {
  repository_seen=0
  all_branches=0
  sources=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --all|--branches|--mirror) all_branches=1 ;;
      -d|--delete) return 0 ;;
      -o|--push-option|--repo|--receive-pack|--exec) shift ;;
      --) ;;
      -*) ;;
      *)
        if [ "$repository_seen" -eq 0 ]; then
          repository_seen=1
        else
          source=\${1#+}
          source=\${source%%:*}
          [ -n "$source" ] && [ "$source" != tag ] && sources+=("$source")
        fi
        ;;
    esac
    [ $# -gt 0 ] && shift
  done

  if [ "$all_branches" -eq 1 ]; then
    printf '%s\\n' --branches
  fi
  if [ "\${#sources[@]}" -eq 0 ]; then
    [ "$all_branches" -eq 1 ] || printf '%s\\n' HEAD
    return 0
  fi
  for source in "\${sources[@]}"; do
    if git_real rev-parse -q --verify "$source^{commit}" >/dev/null 2>&1; then
      printf '%s\\n' "$source"
    fi
  done
}

verify_pushed_commits_are_signed() {
  git_real rev-parse --git-dir >/dev/null 2>&1 || return 0
  revs=$(push_revs "$@")
  [ -n "$revs" ] || return 0
  # Revs are ref names, so they never contain whitespace.
  commits=$(git_real rev-list $revs --not --remotes 2>/dev/null || true)
  [ -n "$commits" ] || return 0

  missing=0
  for commit in $commits; do
    if ! git_real cat-file -p "$commit" | grep -q '^gpgsig'; then
      if [ "$missing" -eq 0 ]; then
        echo "Orchestra: refusing to push unsigned commits:" >&2
      fi
      subject=$(git_real log -1 --format=%s "$commit" 2>/dev/null || true)
      echo "  $commit $subject" >&2
      missing=1
    fi
  done

  if [ "$missing" -ne 0 ]; then
    echo "Re-sign them before pushing (git rebase -S <base>). If signing fails, stop and report it; never commit unsigned." >&2
    exit 1
  fi
}

if [ $# -eq 0 ]; then
  exec "$REAL_GIT" \${globals[@]+"\${globals[@]}"}
fi

command_name=$1
shift
case "$command_name" in
  commit|commit-tree|merge|cherry-pick|revert|rebase|am|pull)
    exec_with_signing "$command_name" "$@"
    ;;
  push)
    verify_pushed_commits_are_signed "$@"
    exec "$REAL_GIT" \${globals[@]+"\${globals[@]}"} push "$@"
    ;;
  *)
    exec "$REAL_GIT" \${globals[@]+"\${globals[@]}"} "$command_name" "$@"
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
