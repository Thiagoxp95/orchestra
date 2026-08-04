import { describe, expect, test } from 'vitest'
import { buildClaudeResumeCommand, buildCodexResumeCommand } from '../shared/action-utils'
import { findClaudeTranscriptById, parseClaudeResumeId } from './resume-transcript'

describe('parseClaudeResumeId', () => {
  test('reads back the id the resume command builder wrote', () => {
    const id = '46bdceab-884c-4b13-8d08-d79acc15b6bc'
    expect(parseClaudeResumeId(buildClaudeResumeCommand(id))).toBe(id)
  })

  test('accepts quoted ids and the -r short flag', () => {
    expect(parseClaudeResumeId(`claude --resume 'a b' --dangerously-skip-permissions`)).toBe('a b')
    expect(parseClaudeResumeId('claude -r sess-1')).toBe('sess-1')
    expect(parseClaudeResumeId('/usr/local/bin/claude --resume sess-2 --foo')).toBe('sess-2')
  })

  test('null for anything that is not a claude resume', () => {
    expect(parseClaudeResumeId(undefined)).toBeNull()
    expect(parseClaudeResumeId('claude --dangerously-skip-permissions')).toBeNull()
    expect(parseClaudeResumeId(buildCodexResumeCommand('codex-9'))).toBeNull()
    expect(parseClaudeResumeId('npm run resume -- --resume x')).toBeNull()
  })
})

describe('findClaudeTranscriptById', () => {
  const home = '/Users/me'
  const projects = `${home}/.claude/projects`

  test('finds the transcript under a project dir unrelated to the resumed cwd', () => {
    // The conversation ran in <repo>/apps/web, but claude launched at the repo
    // root and keeps writing there — the slug for the resumed cwd doesn't exist.
    const found = findClaudeTranscriptById('sess-1', {
      home,
      readdir: () => ['-Users-me-repo-apps-desktop', '-Users-me-repo'],
      exists: (file) => file === `${projects}/-Users-me-repo/sess-1.jsonl`,
    })
    expect(found).toBe(`${projects}/-Users-me-repo/sess-1.jsonl`)
  })

  test('null when no project dir holds it, and when projects is unreadable', () => {
    expect(
      findClaudeTranscriptById('sess-1', { home, readdir: () => ['-a', '-b'], exists: () => false }),
    ).toBeNull()
    expect(
      findClaudeTranscriptById('sess-1', {
        home,
        readdir: () => {
          throw new Error('ENOENT')
        },
        exists: () => true,
      }),
    ).toBeNull()
  })

  test('refuses ids that would escape the project dirs', () => {
    expect(
      findClaudeTranscriptById('../../etc/passwd', { home, readdir: () => ['-a'], exists: () => true }),
    ).toBeNull()
  })
})
