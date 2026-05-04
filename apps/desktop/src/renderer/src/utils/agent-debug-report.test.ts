import { describe, expect, it } from 'vitest'
import { buildAgentDebugReport } from './agent-debug-report'

describe('buildAgentDebugReport', () => {
  it('flags hook/renderer disagreement and includes computed view + normalized details', () => {
    const now = Date.parse('2026-05-04T19:56:22.000Z')
    const report = buildAgentDebugReport({
      generatedAt: now,
      activeWorkspaceId: 'ws-1',
      activeSessionId: 'session-1',
      isDev: false,
      workspaces: {
        'ws-1': {
          id: 'ws-1',
          name: 'Tedy',
          color: '#aa00aa',
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
          label: 'Codex 1',
          processStatus: 'codex',
          cwd: '/repo',
          shellPath: '/bin/zsh',
          actionIcon: '__terminal__',
        },
      },
      claudeWorkState: { 'session-1': 'working' },
      codexWorkState: { 'session-1': 'working' },
      claudeLastResponse: {},
      codexLastResponse: {},
      terminalLastOutput: { 'session-1': 'Codex is doing things' },
      sessionNeedsUserInput: {},
      normalizedAgentState: {
        'session-1': {
          sessionId: 'session-1',
          agent: 'codex',
          state: 'idle',
          authority: 'codex-hook',
          connected: true,
          lastResponsePreview: 'Last response from codex hook',
          lastTransitionAt: now - 50_000,
          updatedAt: now - 50_000,
        },
      },
      agentLaunches: {
        'session-1': {
          agent: 'codex',
          confirmed: true,
          startedAt: now - 53_000,
        },
      },
      liveSessions: [
        {
          sessionId: 'session-1',
          processSessionId: 'proc-1',
          pid: 42371,
          cwd: '/repo',
          isAlive: true,
          status: 'codex',
          aiPid: 42700,
        },
      ],
      codexDebug: [],
      workStateDebug: { path: '/tmp/wsd.log', exists: true, sizeBytes: 0, truncated: false, tail: [] },
    })

    expect(report).toContain('normalized agent=codex state=idle auth=codex-hook connected=yes')
    expect(report).toContain('transitioned=2026-05-04T19:55:32.000Z')
    expect(report).toContain('view isWorking=no needsInput=no needsApproval=no isIdle=yes')
    expect(report).toContain('preview')
    expect(report).toContain('normalized="Last response from codex hook"')
    expect(report).toContain('normalized=idle but codexWorkState=working')
    expect(report).toContain('claudeWorkState=working on codex session')
  })

  it('flags normalized agent / process mismatch', () => {
    const now = Date.parse('2026-05-04T19:56:22.000Z')
    const report = buildAgentDebugReport({
      generatedAt: now,
      activeWorkspaceId: 'ws-1',
      activeSessionId: 'session-1',
      isDev: false,
      workspaces: {
        'ws-1': {
          id: 'ws-1',
          name: 'Tedy',
          color: '#aa00aa',
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
          label: 'Codex 1',
          processStatus: 'codex',
          cwd: '/repo',
          shellPath: '/bin/zsh',
          actionIcon: '__terminal__',
        },
      },
      claudeWorkState: {},
      codexWorkState: { 'session-1': 'idle' },
      claudeLastResponse: {},
      codexLastResponse: {},
      terminalLastOutput: {},
      sessionNeedsUserInput: {},
      normalizedAgentState: {
        'session-1': {
          sessionId: 'session-1',
          agent: 'claude',
          state: 'working',
          authority: 'codex-hook',
          connected: true,
          lastResponsePreview: '',
          lastTransitionAt: now,
          updatedAt: now,
        },
      },
      agentLaunches: {},
      liveSessions: [
        {
          sessionId: 'session-1',
          processSessionId: 'proc-1',
          pid: 1,
          cwd: '/repo',
          isAlive: true,
          status: 'codex',
          aiPid: 2,
        },
      ],
      codexDebug: [],
      workStateDebug: { path: '/tmp/wsd.log', exists: true, sizeBytes: 0, truncated: false, tail: [] },
    })

    expect(report).toContain('normalized agent=claude but session process=codex (sidebar will ignore normalized state)')
  })

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
      codexDebug: [],
      workStateDebug: {
        path: '/tmp/work-state-debug.log',
        exists: true,
        sizeBytes: 512,
        truncated: false,
        tail: [
          '2026-03-21T11:59:50.000Z process-change {"sessionId":"session-1","status":"claude"}',
          '2026-03-21T11:59:59.000Z terminal-notification {"sessionId":"session-1","title":"Claude Code"}',
        ],
      },
    })

    expect(report).toContain('Orchestra agent debug report')
    expect(report).toContain('renderer process=claude claude=idle')
    expect(report).toContain('Orphan live sessions')
    expect(report).toContain('orphan-live alive=yes pid=999')
    expect(report).toContain('Work-state log tail')
    expect(report).toContain('terminal-notification')
  })
})
