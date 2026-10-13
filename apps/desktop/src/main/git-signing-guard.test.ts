import { describe, expect, it, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
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

// Skip an installed guard (agent shells run with it first in PATH).
const realGitDir = path.dirname(
  execFileSync('/usr/bin/which', ['-a', 'git'], { encoding: 'utf8' })
    .split('\n')
    .find((p) => p && !p.includes(`${path.sep}git-guard${path.sep}`))!,
)

// A repo whose main is pushed and whose `feature` branch holds one unsigned
// commit; main stays checked out, so HEAD has nothing to push.
function makeRepoWithUnsignedBranch(home: string): { repo: string; env: Record<string, string> } {
  const env = {
    HOME: home,
    PATH: `${realGitDir}:/usr/bin:/bin`,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  }
  const origin = path.join(home, 'origin.git')
  const repo = path.join(home, 'repo')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env, stdio: 'pipe' })
  execFileSync('git', ['init', '-q', '--bare', origin], { env })
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env })
  git('commit', '-q', '--allow-empty', '-m', 'base')
  git('remote', 'add', 'origin', origin)
  git('push', '-q', 'origin', 'main')
  git('checkout', '-q', '-b', 'feature')
  git('commit', '-q', '--allow-empty', '-m', 'unsigned work')
  git('checkout', '-q', 'main')
  return { repo, env }
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
  "rev-parse -q --verify HEAD^{commit}") echo "abc123"; exit 0 ;;
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

  it('adds -S after global options', () => {
    const home = makeTmpDir()
    const fakeBin = path.join(home, 'fake-bin')
    const argsFile = path.join(home, 'args.txt')
    const guard = ensureGitSigningGuardScript({ HOME: home }).path
    writeExecutable(path.join(fakeBin, 'git'), `#!/bin/sh
printf '%s\\n' "$@" > "$ARGS_FILE"
`)

    const result = spawnSync(guard, ['-C', '/tmp/wt', '-c', 'core.quotepath=off', 'commit', '-m', 'test'], {
      env: {
        PATH: `${path.dirname(guard)}:${fakeBin}:/usr/bin:/bin`,
        ARGS_FILE: argsFile,
      },
      encoding: 'utf8',
    })

    expect(result.status).toBe(0)
    expect(fs.readFileSync(argsFile, 'utf8').trim().split('\n')).toEqual([
      '-C', '/tmp/wt', '-c', 'core.quotepath=off', 'commit', '-S', '-m', 'test',
    ])
  })

  it('rejects turning commit.gpgsign off with -c', () => {
    const home = makeTmpDir()
    const fakeBin = path.join(home, 'fake-bin')
    const guard = ensureGitSigningGuardScript({ HOME: home }).path
    writeExecutable(path.join(fakeBin, 'git'), '#!/bin/sh\nexit 0\n')

    const result = spawnSync(guard, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'test'], {
      env: { PATH: `${path.dirname(guard)}:${fakeBin}:/usr/bin:/bin` },
      encoding: 'utf8',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('refusing to disable commit signing')
  })

  it('blocks pushing a named branch with unsigned commits when HEAD is clean', () => {
    const home = makeTmpDir()
    const { repo, env } = makeRepoWithUnsignedBranch(home)
    const guard = ensureGitSigningGuardScript({ HOME: home }).path
    const guardEnv = { ...env, PATH: `${path.dirname(guard)}:${env.PATH}` }

    const fromRepo = spawnSync(guard, ['push', '-u', 'origin', 'feature'], { cwd: repo, env: guardEnv, encoding: 'utf8' })
    expect(fromRepo.status).toBe(1)
    expect(fromRepo.stderr).toContain('unsigned work')

    const viaDashC = spawnSync(guard, ['-C', repo, 'push', 'origin', '+feature:refs/heads/other'], { cwd: home, env: guardEnv, encoding: 'utf8' })
    expect(viaDashC.status).toBe(1)
    expect(viaDashC.stderr).toContain('unsigned work')

    const all = spawnSync(guard, ['push', '--all', 'origin'], { cwd: repo, env: guardEnv, encoding: 'utf8' })
    expect(all.status).toBe(1)

    const clean = spawnSync(guard, ['push', 'origin', 'main'], { cwd: repo, env: guardEnv, encoding: 'utf8' })
    expect(clean.status).toBe(0)
  })
})
