import { describe, expect, it } from 'vitest'
import { sanitizeWorkspaces, buildSessionMap } from './remote-bridge-sanitize'
import type { Workspace, TerminalSession } from '../shared/types'

const ws: Record<string, Workspace> = {
  w1: {
    id: 'w1', name: 'App', color: '#fff', emoji: '🚀',
    trees: [{ rootDir: '/repo', sessionIds: ['s1'], displayName: 'main' }],
    activeTreeIndex: 0, createdAt: 1,
    customActions: [
      { id: 'a1', name: 'Deploy', icon: '__terminal__', command: 'npm run deploy', webhookToken: 'WEBHOOK_SECRET' },
    ],
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
  it('fills in the sidebar fallback emoji, in the sidebar order', () => {
    const mk = (id: string, createdAt: number, emoji?: string) =>
      ({ id, name: id, color: '#fff', emoji, trees: [], activeTreeIndex: 0, createdAt, customActions: [] }) as Workspace
    // Keyed out of creation order on purpose: the fallback follows the display order.
    const out = sanitizeWorkspaces({ c: mk('c', 3), a: mk('a', 1, '🎻'), b: mk('b', 2) })
    expect(out.map((w) => w.id)).toEqual(['a', 'b', 'c'])
    expect(out.map((w) => w.emoji)).toEqual(['🎻', '📂', '🗂️'])
  })
  it('keeps only id/name/icon for custom actions', () => {
    const [out] = sanitizeWorkspaces(ws)
    expect(out.customActions).toEqual([{ id: 'a1', name: 'Deploy', icon: '__terminal__' }])
    expect(JSON.stringify(out.customActions)).not.toContain('npm run deploy')
    expect(JSON.stringify(out.customActions)).not.toContain('WEBHOOK_SECRET')
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

  it('mirrors the pin and the user-typed title, so the phone can group and name rows', () => {
    const sessions: Record<string, TerminalSession> = {
      s1: {
        id: 's1', workspaceId: 'w1', label: 'the last prompt I sent', processStatus: 'claude',
        cwd: '/repo', shellPath: '/bin/zsh', pinned: true, customLabel: 'Release cut',
      } as TerminalSession,
    }
    const map = buildSessionMap(sessions)
    expect(map.s1.pinned).toBe(true)
    expect(map.s1.customLabel).toBe('Release cut')
    // The auto label rides along untouched — clearing the custom name on either
    // end has to fall back to it without another round trip.
    expect(map.s1.label).toBe('the last prompt I sent')
  })
})
