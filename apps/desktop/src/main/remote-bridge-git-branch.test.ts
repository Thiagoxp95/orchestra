import { describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { parseGitHead, readTreeBranch } from './remote-bridge-sanitize'

describe('parseGitHead', () => {
  it('extracts the branch from a symbolic ref', () => {
    expect(parseGitHead('ref: refs/heads/feat/orchestra-web-remote\n')).toBe('feat/orchestra-web-remote')
  })

  it('keeps slashes in the branch name', () => {
    expect(parseGitHead('ref: refs/heads/ENG-4492')).toBe('ENG-4492')
  })

  it('returns a short sha for a detached HEAD', () => {
    expect(parseGitHead('0123456789abcdef0123456789abcdef01234567')).toBe('0123456')
  })

  it('returns undefined for empty or unrecognized contents', () => {
    expect(parseGitHead('')).toBeUndefined()
    expect(parseGitHead('   ')).toBeUndefined()
    expect(parseGitHead('garbage')).toBeUndefined()
  })
})

describe('readTreeBranch', () => {
  it("reads this repo's current branch from the filesystem", () => {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
    const expected = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim()
    expect(readTreeBranch(repoRoot)).toBe(expected)
  })

  it('returns undefined for a non-repo directory', () => {
    expect(readTreeBranch('/tmp')).toBeUndefined()
  })
})
