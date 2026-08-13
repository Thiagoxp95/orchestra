// Reading the desktop's auto-updater from the phone.
//
// The desktop mirrors its updater into `remoteState.updateStatus`, and the web
// sends a single `restartToUpdate` command back. That command means two
// different things depending on what the desktop has already staged: with a
// build downloaded it restarts and installs, and with nothing staged it kicks
// off a check whose progress comes back through this same object. The button is
// therefore a two-tap control, and the first tap must not read as a no-op — see
// the labels below, every one of which says what is happening now.
//
// Kept free of React so the state machine can be unit-tested like the rest of
// src/lib; the component (DesktopUpdateButton) only picks an icon.

/** The updater's own phase, as the desktop reports it. */
export type DesktopUpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

/** `remoteState.updateStatus`, as mirrored by a desktop that has this feature. */
export interface DesktopUpdateStatus {
  /** False in dev and unsigned builds — the updater can't run at all there. */
  supported: boolean
  state: DesktopUpdateState
  updateAvailable: boolean
  /** Staged on disk: a tap now restarts and installs. */
  updateDownloaded: boolean
  currentVersion: string
  availableVersion: string | null
  /** Only while downloading, quantized to 10%. */
  percent: number | null
  /** Restart accepted, app going down. */
  restartPending: boolean
  /** Error copy, when state is 'error'. */
  message: string | null
  releaseUrl: string | null
}

/** What the button should look like and say. */
export interface DesktopUpdateView {
  icon: 'install' | 'check' | 'busy' | 'error'
  /** Both the aria-label and the title — the version lives in here. */
  label: string
  /** True while the desktop is mid-flight, or can't update at all. */
  disabled: boolean
  /** 'ready' is the one state worth coloring: something is staged to install. */
  tone: 'ready' | 'muted' | 'error'
}

/**
 * Is this object a desktop that can talk about updates at all?
 *
 * `updateStatus` is absent on a pre-migration mirror row and on any desktop
 * older than this feature — and the web deploys independently of (usually
 * before) the desktop build, so "absent" is the live state for a while after
 * shipping. Nothing about that case is worth rendering: a button that reports
 * on an updater the desktop doesn't have is a lie in whichever direction it
 * points, so the caller hides it entirely rather than disabling it.
 */
function asStatus(raw: unknown): DesktopUpdateStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Partial<DesktopUpdateStatus>
  if (typeof s.state !== 'string') return null
  return {
    supported: s.supported === true,
    state: s.state as DesktopUpdateState,
    updateAvailable: s.updateAvailable === true,
    updateDownloaded: s.updateDownloaded === true,
    currentVersion: typeof s.currentVersion === 'string' ? s.currentVersion : '',
    availableVersion: typeof s.availableVersion === 'string' ? s.availableVersion : null,
    percent: typeof s.percent === 'number' ? s.percent : null,
    restartPending: s.restartPending === true,
    message: typeof s.message === 'string' ? s.message : null,
    releaseUrl: typeof s.releaseUrl === 'string' ? s.releaseUrl : null,
  }
}

/** `1.21.47 → 1.21.48`, or just the running version when there's nothing newer. */
function versions(status: DesktopUpdateStatus): string {
  const from = status.currentVersion || '?'
  const to = status.availableVersion
  return to && to !== status.currentVersion ? `${from} → ${to}` : from
}

/**
 * The button's whole appearance, from the mirrored status — or null to hide it.
 *
 * `nudged` is the web's own optimism: `sendCommand` resolves the moment the
 * command is queued, and the desktop needs a beat to pick it up and flip
 * `state` to 'checking'. Without it the first tap of the two would look like
 * nothing happened, which is exactly the tap a user retries forever.
 */
export function describeDesktopUpdate(
  raw: unknown,
  { nudged = false }: { nudged?: boolean } = {},
): DesktopUpdateView | null {
  const status = asStatus(raw)
  if (!status) return null

  const v = versions(status)

  if (!status.supported) {
    return {
      icon: 'check',
      label: `Desktop updates aren't available in this build (${v})`,
      disabled: true,
      tone: 'muted',
    }
  }

  // Going down now — nothing else about the status matters.
  if (status.restartPending) {
    return { icon: 'busy', label: 'Restarting the desktop to update…', disabled: true, tone: 'muted' }
  }

  switch (status.state) {
    case 'checking':
      return { icon: 'busy', label: 'Checking for a desktop update…', disabled: true, tone: 'muted' }
    case 'downloading': {
      const pct = status.percent != null ? ` — ${Math.round(status.percent)}%` : ''
      return {
        icon: 'busy',
        label: `Downloading the desktop update (${v})${pct}`,
        disabled: true,
        tone: 'muted',
      }
    }
    case 'downloaded':
      return {
        icon: 'install',
        label: `Restart desktop to update — ${v}`,
        disabled: false,
        tone: 'ready',
      }
    case 'available':
      // Downloading starts on its own; the tap that would follow is the install,
      // so this reads as progress rather than as an action going begging.
      return {
        icon: 'busy',
        label: `Desktop update ${v} — downloading…`,
        disabled: true,
        tone: 'muted',
      }
    case 'error':
      return {
        icon: 'error',
        label: `Desktop update failed${status.message ? ` — ${status.message}` : ''}. Tap to try again.`,
        disabled: false,
        tone: 'error',
      }
    default:
      break
  }

  // 'idle' / 'not-available': nothing staged, so a tap checks rather than
  // restarts. Once the check finds something the desktop downloads it and the
  // next tap installs.
  if (nudged) {
    return { icon: 'busy', label: 'Asking the desktop to check for updates…', disabled: true, tone: 'muted' }
  }
  if (status.updateDownloaded) {
    return { icon: 'install', label: `Restart desktop to update — ${v}`, disabled: false, tone: 'ready' }
  }
  return {
    icon: 'check',
    label:
      status.state === 'not-available'
        ? `Desktop is up to date (${v}) — tap to check again`
        : `Check the desktop for updates (${v})`,
    disabled: false,
    tone: 'muted',
  }
}
