import { describe, expect, it } from 'vitest'
import {
  CLAUDE_SLASH_COMMANDS,
  CODEX_SLASH_COMMANDS,
  builtInsFor,
  matchSlashCommands,
  mergeSlashCommands,
} from './slash-commands'

describe('matchSlashCommands', () => {
  it('only engages while a command name is being typed', () => {
    expect(matchSlashCommands('')).toEqual([])
    expect(matchSlashCommands('hello')).toEqual([])
    // an argument has started — the box must get out of the way
    expect(matchSlashCommands('/model op')).toEqual([])
    expect(matchSlashCommands('/compact now')).toEqual([])
  })

  it('a bare slash lists the catalog head in curated order', () => {
    const names = matchSlashCommands('/').map((c) => c.name)
    expect(names).toEqual(CLAUDE_SLASH_COMMANDS.slice(0, 8).map((c) => c.name))
  })

  it('caps the list', () => {
    expect(matchSlashCommands('/').length).toBeLessThanOrEqual(8)
    expect(matchSlashCommands('/e', 3).length).toBeLessThanOrEqual(3)
  })

  it('ranks a prefix match first', () => {
    expect(matchSlashCommands('/comp')[0]?.name).toBe('compact')
    expect(matchSlashCommands('/sec')[0]?.name).toBe('security-review')
  })

  it('every prefix match outranks every scattered match', () => {
    const names = matchSlashCommands('/co').map((c) => c.name)
    const lastPrefix = names.map((n) => n.startsWith('co')).lastIndexOf(true)
    const firstScattered = names.map((n) => n.startsWith('co')).indexOf(false)
    if (firstScattered !== -1) expect(lastPrefix).toBeLessThan(firstScattered)
  })

  it('matches scattered subsequences and hyphen word-starts', () => {
    expect(matchSlashCommands('/cmpt').map((c) => c.name)).toContain('compact')
    expect(matchSlashCommands('/ghub').map((c) => c.name)).toContain('install-github-app')
  })

  it('is case-insensitive and tolerant of surrounding whitespace', () => {
    expect(matchSlashCommands('/COMP')[0]?.name).toBe('compact')
    expect(matchSlashCommands('  /comp  ')[0]?.name).toBe('compact')
  })

  it('returns nothing for a query no command contains', () => {
    expect(matchSlashCommands('/xyzq')).toEqual([])
  })
})

describe('mergeSlashCommands', () => {
  const mirrored = [
    { name: 'tedy-qa', description: 'QA the app' },
    { name: 'desktop:dev', description: 'Start the desktop app' },
  ]

  it('falls back to the built-ins when the desktop mirrors nothing', () => {
    expect(mergeSlashCommands(undefined)).toBe(CLAUDE_SLASH_COMMANDS)
    expect(mergeSlashCommands([])).toBe(CLAUDE_SLASH_COMMANDS)
  })

  it('appends the user’s own commands after the built-ins', () => {
    const merged = mergeSlashCommands(mirrored)
    expect(merged.slice(0, CLAUDE_SLASH_COMMANDS.length)).toEqual(CLAUDE_SLASH_COMMANDS)
    expect(merged.map((c) => c.name)).toContain('tedy-qa')
  })

  it('never lists a name twice — a built-in wins over a same-named mirror', () => {
    const merged = mergeSlashCommands([{ name: 'init', description: 'my own init' }, ...mirrored])
    expect(merged.filter((c) => c.name === 'init')).toHaveLength(1)
    expect(merged.find((c) => c.name === 'init')?.description).toBe(
      CLAUDE_SLASH_COMMANDS.find((c) => c.name === 'init')?.description,
    )
  })

  it('finds a mirrored command by fuzzy query, like any built-in', () => {
    const catalog = mergeSlashCommands(mirrored)
    expect(matchSlashCommands('/tedy', 20, catalog)[0]?.name).toBe('tedy-qa')
    expect(matchSlashCommands('/dsk', 20, catalog).map((c) => c.name)).toContain('desktop:dev')
  })

  it('merges onto whichever CLI’s built-ins it is given', () => {
    const merged = mergeSlashCommands(mirrored, CODEX_SLASH_COMMANDS)
    expect(merged.slice(0, CODEX_SLASH_COMMANDS.length)).toEqual(CODEX_SLASH_COMMANDS)
    expect(merged.map((c) => c.name)).toContain('tedy-qa')
    // the claude built-ins must not leak into a codex session
    expect(merged.map((c) => c.name)).not.toContain('security-review')
  })
})

describe('builtInsFor', () => {
  it('gives each CLI its own catalog', () => {
    expect(builtInsFor('claude')).toBe(CLAUDE_SLASH_COMMANDS)
    expect(builtInsFor('codex')).toBe(CODEX_SLASH_COMMANDS)
  })

  it('offers nothing for a shell or unknown session', () => {
    // A plain shell has no slash commands at all; suggesting claude's would be
    // worse than an empty box.
    expect(builtInsFor(undefined)).toEqual([])
    expect(builtInsFor('bash')).toEqual([])
  })

  it('opens no popup at all when the agent has no catalog', () => {
    const catalog = mergeSlashCommands([], builtInsFor(undefined))
    expect(matchSlashCommands('/', 20, catalog)).toEqual([])
  })
})

describe('CODEX_SLASH_COMMANDS', () => {
  it('autocompletes codex names that claude does not have', () => {
    const names = CODEX_SLASH_COMMANDS.map((c) => c.name)
    expect(names).toContain('permissions')
    expect(names).toContain('mention')
    expect(names).toContain('new')
    // /effort is claude-only: codex folds reasoning effort into /model
    expect(names).not.toContain('effort')
  })

  it('ranks a codex prefix match first', () => {
    expect(matchSlashCommands('/perm', 20, CODEX_SLASH_COMMANDS)[0]?.name).toBe('permissions')
    expect(matchSlashCommands('/comp', 20, CODEX_SLASH_COMMANDS)[0]?.name).toBe('compact')
  })

  it('leads with the most-reached-for commands on a bare slash', () => {
    expect(matchSlashCommands('/', 3, CODEX_SLASH_COMMANDS).map((c) => c.name)).toEqual([
      'model',
      'compact',
      'new',
    ])
  })

  it('lists every name exactly once', () => {
    const names = CODEX_SLASH_COMMANDS.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('holds only names the TUI can actually be sent', () => {
    for (const c of CODEX_SLASH_COMMANDS) {
      expect(c.name).toMatch(/^[a-z0-9][a-z0-9:_-]*$/)
      expect(c.description.length).toBeGreaterThan(0)
    }
  })
})
