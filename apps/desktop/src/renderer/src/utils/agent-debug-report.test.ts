import { describe, expect, it } from 'vitest'
import { buildAgentDebugReport } from './agent-debug-report'

describe('buildAgentDebugReport', () => {
  it('includes renderer state, watcher state, mismatches, and log tail', () => {
    const report = buildAgentDebugReport({
      generatedAt: Date.parse('2026-03-21T12:00:00.000Z'),
      activeWorkspaceId: 'ws-1',
      activeSessionId: 'session-1',
      isDev: true,
      workspaces: {
        'ws-1': {
          id: 'ws-1',
          name: 'Orchestra',
          color: '#111111',
          trees: [{ rootDir: '/repo', sessionIds: ['session-1'] }],
          activeTreeIndex: 0,
          customActions: [],
          createdAt: 1,
        },
      },
      sessions: {
        'session-1': {
          id: 'session-1',
          workspaceId: 'ws-1',
          label: 'Claude 1',
          processStatus: 'claude',
          cwd: '/repo',
          shellPath: '/bin/zsh',
          actionIcon: '__claude__',
        },
      },
      claudeWorkState: { 'session-1': 'idle' },
      codexWorkState: {},
      claudeLastResponse: { 'session-1': 'Investigating the sidebar state bug' },
      codexLastResponse: {},
      terminalLastOutput: { 'session-1': 'working...' },
      sessionNeedsUserInput: {},
      normalizedAgentState: {},
      agentLaunches: {
        'session-1': {
          agent: 'claude',
          confirmed: true,
          startedAt: Date.parse('2026-03-21T11:59:45.000Z'),
        },
      },
      liveSessions: [
        {
          sessionId: 'session-1',
          processSessionId: 'proc-1',
          pid: 123,
          cwd: '/repo',
          isAlive: true,
          status: 'claude',
          aiPid: 456,
        },
        {
          sessionId: 'orphan-live',
          processSessionId: 'proc-2',
          pid: 999,
          cwd: '/tmp',
          isAlive: true,
          status: 'terminal',
          aiPid: null,
        },
      ],
      claudeDebug: [
        {
          sessionId: 'session-1',
          cwd: '/repo',
          lastWorkState: 'working',
          lastHookEvent: 'Start',
          lastHookEventAt: Date.parse('2026-03-21T11:59:50.000Z'),
        },
      ],
      codexDebug: [],
      workStateDebug: {
        path: '/tmp/work-state-debug.log',
        exists: true,
        sizeBytes: 512,
        truncated: false,
        tail: [
          '2026-03-21T11:59:50.000Z process-change {"sessionId":"session-1","status":"claude"}',
          '2026-03-21T11:59:59.000Z claude-hook-event {"sessionId":"session-1","eventType":"Start"}',
        ],
      },
    })

    expect(report).toContain('Orchestra agent debug report')
    expect(report).toContain('renderer process=claude claude=idle')
    expect(report).toContain('claudeWatcher state=working hook=Start')
    expect(report).toContain('mismatch claude state renderer=idle watcher=working | claude hook=Start renderer=idle')
    expect(report).toContain('Orphan live sessions')
    expect(report).toContain('orphan-live alive=yes pid=999')
    expect(report).toContain('Work-state log tail')
    expect(report).toContain('claude-hook-event')
  })
})
