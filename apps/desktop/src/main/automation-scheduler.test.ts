import { afterEach, describe, expect, it, vi } from 'vitest'

const workspaces: Record<string, unknown> = {}
let saved: Record<string, { nextRunAt: number; lastRunAt: number }> = {}

vi.mock('electron', () => ({ BrowserWindow: class {}, Notification: class { show() {} } }))
vi.mock('./persistence', () => ({
  loadSchedulerState: () => saved,
  saveSchedulerState: (s: typeof saved) => { saved = s },
  saveAutomationRun: () => {},
  deleteAutomationRuns: () => {},
  loadPersistedData: () => ({ workspaces }),
}))

import { getSchedulerSyncData, initAutomationScheduler, noteExternalRuns, refreshSchedules, stopAutomationScheduler } from './automation-scheduler'

const sent: Record<string, number>[] = []
const win = {
  isDestroyed: () => false,
  webContents: { on: () => {}, send: (_: string, data: Record<string, number>) => sent.push(data) },
} as never

const action = (id: string, schedule: object) => ({ id, name: id, icon: 'x', command: 'true', schedule, automationEnabled: true })

afterEach(() => {
  stopAutomationScheduler()
  sent.length = 0
})

describe('automation scheduler sync', () => {
  it('schedules and pushes an automation added after start, without waiting for a tick', () => {
    workspaces.w = { id: 'w', trees: [{ rootDir: '/r' }], customActions: [] }
    initAutomationScheduler(win)
    expect(getSchedulerSyncData().added).toBeUndefined()

    ;(workspaces.w as { customActions: unknown[] }).customActions.push(action('added', { mode: 'daily', time: '09:00', days: [1] }))
    refreshSchedules()
    expect(getSchedulerSyncData().added).toBeGreaterThan(Date.now())
    expect(sent.at(-1)?.added).toBe(getSchedulerSyncData().added)
  })

  it('counts a run the daemon made while the app was closed', () => {
    const hour = 60 * 60_000
    const schedule = { mode: 'interval', intervalMinutes: 60, days: [1, 2, 3, 4, 5, 6, 7] }
    workspaces.w = { id: 'w', trees: [{ rootDir: '/r' }], customActions: [action('loop', schedule)] }
    saved = { loop: { lastRunAt: Date.now() - 5 * hour, nextRunAt: Date.now() - 4 * hour, schedule } as never }
    initAutomationScheduler(win)
    const ranAt = Date.now() - 10 * 60_000
    noteExternalRuns([{ actionId: 'loop', startedAt: ranAt }])
    expect(getSchedulerSyncData().loop).toBe(ranAt + hour)
  })
})
