import { describe, expect, it } from 'vitest'
import { sanitizeWorkspaces, buildSessionMap } from './remote-bridge-sanitize'
import type { Workspace, TerminalSession } from '../shared/types'

const ws: Record<string, Workspace> = {
  w1: {
    id: 'w1', name: 'App', color: '#fff', emoji: '🚀',
    trees: [{ rootDir: '/repo', sessionIds: ['s1'], displayName: 'main' }],
    activeTreeIndex: 0, customActions: [], createdAt: 1,
    linearConfig: { apiKey: 'SECRET', teamId: 't', teamName: 'T' },
  } as Workspace,
}

describe('sanitizeWorkspaces', () => {
  it('keeps display fields and trees', () => {
    const [out] = sanitizeWorkspaces(ws)
    expect(out.id).toBe('w1')
    expect(out.name).toBe('App')
    expect(out.emoji).toBe('🚀')
    expect(out.trees[0]).toEqual({ rootDir: '/repo', sessionIds: ['s1'], displayName: 'main' })
    expect(out.activeTreeIndex).toBe(0)
  })
  it('drops linearConfig and any secret fields', () => {
    const [out] = sanitizeWorkspaces(ws)
    expect((out as any).linearConfig).toBeUndefined()
    expect(JSON.stringify(out)).not.toContain('SECRET')
  })
})

describe('buildSessionMap', () => {
  it('keeps only safe session fields', () => {
    const sessions: Record<string, TerminalSession> = {
      s1: { id: 's1', workspaceId: 'w1', label: 'claude', processStatus: 'claude', cwd: '/repo', shellPath: '/bin/zsh', actionIcon: 'Bot' } as TerminalSession,
    }
    const map = buildSessionMap(sessions)
    expect(map.s1).toEqual({ label: 'claude', processStatus: 'claude', cwd: '/repo', workspaceId: 'w1', actionIcon: 'Bot' })
    expect((map.s1 as any).shellPath).toBeUndefined()
  })
})
