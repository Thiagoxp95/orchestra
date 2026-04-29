import { describe, expect, it, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  buildGitSigningGuardEnv,
  ensureGitSigningGuardScript,
  getGitSigningGuardDir,
  prependPathEntry,
} from './git-signing-guard'

const tmpDirs: string[] = []

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-git-guard-'))
  tmpDirs.push(dir)
  return dir
}

function writeExecutable(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, { mode: 0o755 })
}

describe('git signing guard', () => {
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prepends the guard path without duplicating it', () => {
    expect(prependPathEntry('/usr/bin:/bin', '/guard', 'darwin')).toBe('/guard:/usr/bin:/bin')
    expect(prependPathEntry('/usr/bin:/guard:/bin', '/guard', 'darwin')).toBe('/guard:/usr/bin:/bin')
  })

  it('builds an agent env with the guard first in PATH', () => {
    const env = buildGitSigningGuardEnv(
      { PATH: '/usr/bin:/bin' },
      { HOME: '/Users/txp' },
      'darwin',
    )

    expect(env.ORCHESTRA_GIT_SIGNING_GUARD).toBe('1')
    expect(env.PATH).toBe(
      `${getGitSigningGuardDir({ HOME: '/Users/txp' })}:/usr/bin:/bin:/Users/txp/.orchestra/bin:/Users/txp/.bun/bin:/Users/txp/.local/bin:/Users/txp/bin:/opt/homebrew/bin:/usr/local/bin`
    )
  })

  it('adds -S to git commit invocations', () => {
    const home = makeTmpDir()
    const fakeBin = path.join(home, 'fake-bin')
    const argsFile = path.join(home, 'args.txt')
    const guard = ensureGitSigningGuardScript({ HOME: home }).path
    writeExecutable(path.join(fakeBin, 'git'), `#!/bin/sh
printf '%s\\n' "$@" > "$ARGS_FILE"
`)

    const result = spawnSync(guard, ['commit', '-m', 'test'], {
      env: {
        PATH: `${path.dirname(guard)}:${fakeBin}:/usr/bin:/bin`,
        ARGS_FILE: argsFile,
      },
      encoding: 'utf8',
    })

    expect(result.status).toBe(0)
    expect(fs.readFileSync(argsFile, 'utf8').trim().split('\n')).toEqual([
      'commit',
      '-S',
      '-m',
      'test',
    ])
  })

  it('does not add -S to git operation continuations', () => {
    const home = makeTmpDir()
    const fakeBin = path.join(home, 'fake-bin')
    const argsFile = path.join(home, 'args.txt')
    const guard = ensureGitSigningGuardScript({ HOME: home }).path
    writeExecutable(path.join(fakeBin, 'git'), `#!/bin/sh
printf '%s\\n' "$@" > "$ARGS_FILE"
`)

    const result = spawnSync(guard, ['rebase', '--continue'], {
      env: {
        PATH: `${path.dirname(guard)}:${fakeBin}:/usr/bin:/bin`,
        ARGS_FILE: argsFile,
      },
      encoding: 'utf8',
    })

    expect(result.status).toBe(0)
    expect(fs.readFileSync(argsFile, 'utf8').trim().split('\n')).toEqual([
      'rebase',
      '--continue',
    ])
  })

  it('rejects explicit unsigned commits', () => {
    const home = makeTmpDir()
    const fakeBin = path.join(home, 'fake-bin')
    const guard = ensureGitSigningGuardScript({ HOME: home }).path
    writeExecutable(path.join(fakeBin, 'git'), '#!/bin/sh\nexit 0\n')

    const result = spawnSync(guard, ['commit', '--no-gpg-sign', '-m', 'test'], {
      env: { PATH: `${path.dirname(guard)}:${fakeBin}:/usr/bin:/bin` },
      encoding: 'utf8',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('refusing to create an unsigned commit')
  })

  it('blocks pushes when local-only commits are unsigned', () => {
    const home = makeTmpDir()
    const fakeBin = path.join(home, 'fake-bin')
    const guard = ensureGitSigningGuardScript({ HOME: home }).path
    writeExecutable(path.join(fakeBin, 'git'), `#!/bin/sh
case "$*" in
  "rev-parse --git-dir") echo ".git"; exit 0 ;;
  "rev-list HEAD --not --remotes") echo "abc123"; exit 0 ;;
  "cat-file -p abc123") echo "tree deadbeef"; exit 0 ;;
  "log -1 --format=%s abc123") echo "unsigned subject"; exit 0 ;;
esac
printf 'unexpected %s\\n' "$*" >&2
exit 2
`)

    const result = spawnSync(guard, ['push', 'origin', 'HEAD'], {
      env: { PATH: `${path.dirname(guard)}:${fakeBin}:/usr/bin:/bin` },
      encoding: 'utf8',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('refusing to push unsigned commits')
    expect(result.stderr).toContain('abc123 unsigned subject')
  })
})
