import { describe, expect, it } from 'vitest'
import { CLAUDE_SLASH_COMMANDS, matchSlashCommands } from './slash-commands'

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
