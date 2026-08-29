import { describe, expect, it } from 'vitest'
import { describeDesktopUpdate, type DesktopUpdateStatus } from './desktop-update'

const status = (over: Partial<DesktopUpdateStatus> = {}): DesktopUpdateStatus => ({
  supported: true,
  state: 'idle',
  updateAvailable: false,
  updateDownloaded: false,
  currentVersion: '1.21.47',
  availableVersion: null,
  percent: null,
  restartPending: false,
  message: null,
  releaseUrl: null,
  ...over,
})

describe('describeDesktopUpdate', () => {
  // The one that ships broken if it's wrong: the web deploys independently of
  // the desktop, so a phone talking to an older desktop (or a mirror row written
  // before the migration) sees no updateStatus at all. The button must not exist
  // there — a disabled one still claims a capability the desktop doesn't have.
  it('hides itself entirely when the desktop mirrors no update status', () => {
    expect(describeDesktopUpdate(undefined)).toBeNull()
    expect(describeDesktopUpdate(null)).toBeNull()
    expect(describeDesktopUpdate({})).toBeNull()
    expect(describeDesktopUpdate('downloaded')).toBeNull()
    expect(describeDesktopUpdate({ supported: true })).toBeNull()
  })

  it('shows but disables itself on a build that cannot update', () => {
    const view = describeDesktopUpdate(status({ supported: false }))
    expect(view?.disabled).toBe(true)
    expect(view?.label).toContain('1.21.47')
  })

  it('offers the install, with both versions in the label, once one is staged', () => {
    const view = describeDesktopUpdate(
      status({ state: 'downloaded', updateAvailable: true, updateDownloaded: true, availableVersion: '1.21.48' }),
    )
    expect(view).toMatchObject({ icon: 'install', disabled: false, tone: 'ready' })
    expect(view?.label).toBe('Restart desktop to update — 1.21.47 → 1.21.48')
  })

  it('reads as busy, not as idle, while the restart is being taken', () => {
    const view = describeDesktopUpdate(status({ state: 'downloaded', updateDownloaded: true, restartPending: true }))
    expect(view).toMatchObject({ icon: 'busy', disabled: true })
    expect(view?.label).toContain('Restarting')
  })

  it('offers a check when nothing is staged — the first of the two taps', () => {
    const idle = describeDesktopUpdate(status())
    expect(idle).toMatchObject({ icon: 'check', disabled: false })
    expect(idle?.label).toContain('1.21.47')
    expect(describeDesktopUpdate(status({ state: 'not-available' }))?.label).toContain('up to date')
  })

  // sendCommand resolves before the desktop has picked the command up, so
  // without this the tap that starts a check looks like a dead button.
  it('acknowledges a tap the desktop has not answered yet', () => {
    const view = describeDesktopUpdate(status(), { nudged: true })
    expect(view).toMatchObject({ icon: 'busy', disabled: true })
    expect(view?.label).toContain('Asking the desktop')
  })

  it('reports the check and the download it turns into', () => {
    expect(describeDesktopUpdate(status({ state: 'checking' }))).toMatchObject({
      icon: 'busy',
      disabled: true,
    })
    const available = describeDesktopUpdate(
      status({ state: 'available', updateAvailable: true, availableVersion: '1.21.48' }),
    )
    expect(available?.label).toContain('1.21.48')
    expect(available?.disabled).toBe(true)
  })

  it('carries the download percentage while there is one', () => {
    const view = describeDesktopUpdate(
      status({ state: 'downloading', updateAvailable: true, availableVersion: '1.21.48', percent: 40 }),
    )
    expect(view?.label).toContain('40%')
    expect(
      describeDesktopUpdate(status({ state: 'downloading', percent: null }))?.label,
    ).not.toContain('%')
  })

  it('surfaces the failure and stays tappable so it can be read', () => {
    const view = describeDesktopUpdate(status({ state: 'error', message: 'ENOTFOUND' }))
    expect(view).toMatchObject({ icon: 'error', disabled: false, tone: 'error' })
    // The reason lives in `detail`, not in `label`: on a phone `title` is never
    // rendered, so a label-only explanation was an alarm with no cause attached.
    expect(view?.detail).toContain('ENOTFOUND')
    expect(view?.label).toMatch(/tap for details/i)
  })

  it('says something rather than nothing when the updater errored without a message', () => {
    const view = describeDesktopUpdate(status({ state: 'error', message: null }))
    expect(view?.detail).toBeTruthy()
    expect(view?.errorKey).toBeTruthy()
  })

  it('keys a failure by message and version, so a new one re-alarms after a dismissal', () => {
    const a = describeDesktopUpdate(status({ state: 'error', message: 'ENOTFOUND' }))
    const same = describeDesktopUpdate(status({ state: 'error', message: 'ENOTFOUND' }))
    const other = describeDesktopUpdate(status({ state: 'error', message: 'checksum mismatch' }))
    const laterVersion = describeDesktopUpdate(
      status({ state: 'error', message: 'ENOTFOUND', availableVersion: '1.21.99' }),
    )
    expect(a?.errorKey).toBe(same?.errorKey)
    expect(a?.errorKey).not.toBe(other?.errorKey)
    expect(a?.errorKey).not.toBe(laterVersion?.errorKey)
  })

  it('carries no failure key when nothing failed, so nothing can be dismissed by accident', () => {
    for (const state of ['idle', 'checking', 'available', 'not-available', 'downloading', 'downloaded'] as const) {
      expect(describeDesktopUpdate(status({ state }))?.errorKey).toBeNull()
    }
  })

  it('does not print an arrow when the available version is the running one', () => {
    const view = describeDesktopUpdate(status({ state: 'not-available', availableVersion: '1.21.47' }))
    expect(view?.label).not.toContain('→')
  })
})
