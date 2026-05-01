import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomAction, VoiceEvent, VoiceStatus } from '../../shared/types'
import { FakeSidecar } from './fake-sidecar'
import { VoiceManager, type Scheduler, type SidecarFactory } from './voice-manager'

// --- Fake scheduler driven by tests --------------------------------------------------

interface FakeTask {
  id: number
  fireAt: number
  callback: () => void
  interval: number | null
}

function createFakeScheduler(): Scheduler & {
  advance: (ms: number) => void
  pendingCount: () => number
  current: () => number
} {
  let id = 0
  let now = 0
  const tasks = new Map<number, FakeTask>()

  return {
    setTimeout(callback, ms) {
      const taskId = ++id
      tasks.set(taskId, { id: taskId, fireAt: now + ms, callback, interval: null })
      return { clear: () => tasks.delete(taskId) }
    },
    setInterval(callback, ms) {
      const taskId = ++id
      tasks.set(taskId, { id: taskId, fireAt: now + ms, callback, interval: ms })
      return { clear: () => tasks.delete(taskId) }
    },
    now() {
      return now
    },
    advance(ms: number) {
      const target = now + ms
      while (true) {
        let next: FakeTask | null = null
        for (const t of tasks.values()) {
          if (t.fireAt <= target && (!next || t.fireAt < next.fireAt)) next = t
        }
        if (!next) break
        now = next.fireAt
        if (next.interval !== null) {
          next.fireAt = now + next.interval
        } else {
          tasks.delete(next.id)
        }
        next.callback()
      }
      now = target
    },
    pendingCount() {
      return tasks.size
    },
    current() {
      return now
    },
  }
}

// --- Test fixtures -------------------------------------------------------------------

function buildAction(id: string, name = id): CustomAction {
  return {
    id,
    name,
    icon: 'rocket',
    command: 'echo hi',
    keybinding: '',
    runOnWorktreeCreation: false,
  }
}

interface Harness {
  manager: VoiceManager
  scheduler: ReturnType<typeof createFakeScheduler>
  spawned: FakeSidecar[]
  spawnFactory: SidecarFactory
  runAction: ReturnType<typeof vi.fn>
  resolveAction: (id: string) => { workspaceId: string; action: CustomAction } | null
  events: VoiceEvent[]
  statuses: VoiceStatus[]
}

function makeHarness(opts: {
  actions?: CustomAction[]
  spawnError?: Error
} = {}): Harness {
  const actions = new Map<string, CustomAction>()
  for (const a of opts.actions ?? [buildAction('act-1', 'ship')]) {
    actions.set(a.id, a)
  }
  const scheduler = createFakeScheduler()
  const spawned: FakeSidecar[] = []
  const spawnFactory: SidecarFactory = () => {
    if (opts.spawnError) throw opts.spawnError
    const handle = new FakeSidecar()
    spawned.push(handle)
    return handle
  }
  const runAction = vi.fn()
  const resolveAction = (id: string) => {
    const action = actions.get(id)
    return action ? { workspaceId: 'ws-1', action } : null
  }
  const manager = new VoiceManager({
    spawn: spawnFactory,
    runAction,
    resolveAction,
    scheduler,
    startupGraceMs: 100,
    heartbeatTimeoutMs: 600,
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  })
  const events: VoiceEvent[] = []
  const statuses: VoiceStatus[] = []
  manager.on('event', (e: VoiceEvent) => events.push(e))
  manager.on('status', (s: VoiceStatus) => statuses.push(s))
  return { manager, scheduler, spawned, spawnFactory, runAction, resolveAction, events, statuses }
}

// --- Tests ---------------------------------------------------------------------------

describe('VoiceManager', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  afterEach(() => {
    // No global state to clean.
  })

  it('enable spawns the sidecar exactly once; second enable is a no-op', async () => {
    const h = makeHarness()
    await h.manager.enable()
    await h.manager.enable()
    expect(h.spawned.length).toBe(1)
  })

  it('disable kills the sidecar and emits a disabled status', async () => {
    const h = makeHarness()
    await h.manager.enable()
    h.scheduler.advance(150) // pass the startup grace
    h.manager.disable()
    const sidecar = h.spawned[0]
    expect(sidecar.killed).toBe(true)
    expect(h.manager.isEnabled()).toBe(false)
    const last = h.statuses[h.statuses.length - 1]
    expect(last.state).toBe('disabled')
  })

  it('pushes vocabulary on swap and forwards the latest payload', async () => {
    const h = makeHarness()
    h.manager.setVocabulary([{ actionId: 'act-1', phrases: ['ship'] }])
    await h.manager.enable()
    h.scheduler.advance(150)
    h.manager.setVocabulary([{ actionId: 'act-2', phrases: ['deploy'] }])
    const sidecar = h.spawned[0]
    const pushes = sidecar.vocabPushes()
    expect(pushes).toHaveLength(2)
    expect(pushes[0]).toEqual([{ actionId: 'act-1', phrases: ['ship'] }])
    expect(pushes[1]).toEqual([{ actionId: 'act-2', phrases: ['deploy'] }])
  })

  it('matched event runs the right action exactly once', async () => {
    const h = makeHarness({ actions: [buildAction('act-1', 'ship')] })
    await h.manager.enable()
    h.scheduler.advance(150)
    h.spawned[0].emit({ type: 'matched', actionId: 'act-1', text: 'ship', confidence: 1 })
    expect(h.runAction).toHaveBeenCalledTimes(1)
    const call = h.runAction.mock.calls[0][0]
    expect(call.workspaceId).toBe('ws-1')
    expect(call.action.id).toBe('act-1')
    expect(call.text).toBe('ship')
  })

  it('drops matched events for stale action ids without running them', async () => {
    const h = makeHarness({ actions: [buildAction('act-1', 'ship')] })
    await h.manager.enable()
    h.scheduler.advance(150)
    h.spawned[0].emit({ type: 'matched', actionId: 'gone', text: 'gone', confidence: 1 })
    expect(h.runAction).not.toHaveBeenCalled()
    // Forwarded as a no_match so the renderer can still surface a bubble.
    expect(h.events.find((e) => e.type === 'no_match')).toBeTruthy()
  })

  it('auto-restarts on crash and gives up after 3 failures within 60s', async () => {
    const h = makeHarness()
    await h.manager.enable()
    h.scheduler.advance(150) // startup confirmed

    // First crash → restart in 1s.
    h.spawned[0].simulateExit(1, null)
    expect(h.statuses.some((s) => s.state === 'restarting')).toBe(true)
    h.scheduler.advance(1000)
    expect(h.spawned.length).toBe(2)
    h.scheduler.advance(150)

    // Second crash → restart in 4s.
    h.spawned[1].simulateExit(1, null)
    h.scheduler.advance(4000)
    expect(h.spawned.length).toBe(3)
    h.scheduler.advance(150)

    // Third crash → restart in 16s.
    h.spawned[2].simulateExit(1, null)
    h.scheduler.advance(16_000)
    expect(h.spawned.length).toBe(4)
    h.scheduler.advance(150)

    // Fourth crash → over the limit, no further spawn.
    h.spawned[3].simulateExit(1, null)
    h.scheduler.advance(20_000)
    expect(h.spawned.length).toBe(4)
    const last = h.statuses[h.statuses.length - 1]
    expect(last.state).toBe('error')
    expect(last.lastError?.code).toBe('sidecar_crash')
  })

  it('treats heartbeat silence as wedge and restarts', async () => {
    const h = makeHarness()
    await h.manager.enable()
    h.scheduler.advance(150) // startup ok, watchdog armed
    h.scheduler.advance(700) // heartbeat timeout (600ms)
    expect(h.spawned[0].killed).toBe(true)
    h.scheduler.advance(1000) // 1s backoff
    expect(h.spawned.length).toBe(2)
  })

  it('reports sidecar_failed_to_spawn when child exits during startup grace', async () => {
    const h = makeHarness()
    await h.manager.enable()
    // Exit before grace window completes.
    h.spawned[0].simulateExit(1, null)
    h.scheduler.advance(200)
    const last = h.statuses[h.statuses.length - 1]
    expect(last.state).toBe('error')
    expect(last.lastError?.code).toBe('sidecar_failed_to_spawn')
    expect(h.spawned.length).toBe(1) // never restarted
  })

  it('captures stderr lines into a ring buffer for the Settings dialog', async () => {
    const h = makeHarness()
    await h.manager.enable()
    h.scheduler.advance(150)
    h.spawned[0].emitStderr('boot: ok')
    h.spawned[0].emitStderr('warning: low rms')
    expect(h.manager.getStderrSnapshot()).toEqual(['boot: ok', 'warning: low rms'])
  })

  it('forwards error events as status updates', async () => {
    const h = makeHarness()
    await h.manager.enable()
    h.scheduler.advance(150)
    h.spawned[0].emit({ type: 'error', code: 'mic_denied', message: 'no permission' })
    const last = h.statuses[h.statuses.length - 1]
    expect(last.state).toBe('error')
    expect(last.lastError?.code).toBe('mic_denied')
  })
})
