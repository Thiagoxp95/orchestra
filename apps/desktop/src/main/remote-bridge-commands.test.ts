import { describe, expect, it } from 'vitest'
import { toSlashCommands } from './remote-bridge-commands'
import type { SkillEntry } from '../shared/types'

function entry(over: Partial<SkillEntry>): SkillEntry {
  return {
    id: 'x',
    name: 'thing',
    description: '',
    source: 'claude-skill',
    scope: 'user',
    filePath: '/tmp/thing/SKILL.md',
    ...over,
  }
}

describe('toSlashCommands', () => {
  it('keeps claude-invocable entries and drops codex skills', () => {
    const out = toSlashCommands([
      entry({ name: 'tedy-qa', source: 'claude-skill' }),
      entry({ name: 'desktop:dev', source: 'claude-command' }),
      entry({ name: 'paper:review', source: 'claude-plugin' }),
      entry({ name: 'codex-only', source: 'codex-skill' }),
    ])
    expect(out.map((c) => c.name)).toEqual(['desktop:dev', 'paper:review', 'tedy-qa'])
  })

  it('spells a nested skill path with claude’s namespace separator', () => {
    expect(toSlashCommands([entry({ name: 'gstack/browse' })])[0].name).toBe('gstack:browse')
  })

  it('drops names that cannot be typed after a slash', () => {
    const out = toSlashCommands([
      entry({ name: 'has a space' }),
      entry({ name: '-leading-dash' }),
      entry({ name: '' }),
      entry({ name: 'fine' }),
    ])
    expect(out.map((c) => c.name)).toEqual(['fine'])
  })

  it('dedupes by name and caps the list', () => {
    const dupes = [entry({ name: 'a', description: 'first' }), entry({ name: 'a', description: 'second' })]
    expect(toSlashCommands(dupes)).toEqual([{ name: 'a', description: 'first' }])
    const many = Array.from({ length: 40 }, (_, i) => entry({ name: `cmd${i}` }))
    expect(toSlashCommands(many, 10)).toHaveLength(10)
  })

  it('flattens and truncates long descriptions (the mirrored doc is shared state)', () => {
    const long = 'x'.repeat(200)
    const out = toSlashCommands([entry({ name: 'a', description: `line one\n  ${long}` })])
    expect(out[0].description.length).toBeLessThanOrEqual(90)
    expect(out[0].description).not.toContain('\n')
    expect(out[0].description.endsWith('…')).toBe(true)
  })
})
