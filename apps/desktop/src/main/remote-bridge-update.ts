// Shapes the desktop's auto-update state for the web mirror, and decides what a
// remote "restart & install" tap should actually do.
//
// The desktop already knows everything about a pending update (updater.ts owns
// the electron-updater event stream); the phone knows nothing. Mirroring a small
// verdict — is there an update, is it staged, which versions — is what lets the
// web render a meaningful "Restart & update" button instead of a blind one.
//
// Deliberately free of Electron/electron-updater imports so both the payload
// shaping and the restart decision are unit-testable: updater.ts holds the
// mutable state and calls in here for the pure parts.

import type { UpdateStatus, UpdateStatusType } from '../shared/types'

/** `idle` = the updater has never reported anything (fresh launch, or a build
 *  with no update metadata at all). */
export type MirroredUpdateState = UpdateStatusType | 'idle'

export interface MirroredUpdate {
  /** False in dev / unsigned builds with no app-update.yml: there is no update
   *  channel at all, so the web must render the button disabled rather than
   *  firing a command nothing can serve. */
  supported: boolean
  state: MirroredUpdateState
  /** A newer version exists — available, downloading, or already staged. */
  updateAvailable: boolean
  /** Staged on disk: a restart installs it immediately, no download wait. */
  updateDownloaded: boolean
  currentVersion: string
  /** The version an update would move to, when one is known. */
  availableVersion: string | null
  /** Download progress, quantized to 10% — see quantizePercent. */
  percent: number | null
  /** A restart-to-update has been accepted and the app is on its way down.
   *  Latches, so a second tap renders as "restarting" instead of re-arming. */
  restartPending: boolean
  /** Friendly copy for a real (non-network) updater error. */
  message: string | null
  releaseUrl: string | null
}

/**
 * electron-updater emits download-progress dozens of times per download. The
 * mirror is a change-triggered push, so mirroring the raw percent would turn one
 * download into one Convex write per progress tick. 10% steps keep the phone's
 * progress readable at a bounded ten pushes per download.
 */
export function quantizePercent(percent: unknown): number | null {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null
  return Math.max(0, Math.min(100, Math.round(percent / 10) * 10))
}

export interface MirroredUpdateInput {
  /** Last status the updater emitted, or null if it never has. */
  status: UpdateStatus | null
  /** Version currently staged on disk (set on update-downloaded, and never
   *  cleared by a later `checking` — the file is still there). Tracked apart
   *  from `status` precisely because status is transient. */
  downloadedVersion: string | null
  currentVersion: string
  supported: boolean
  restartPending: boolean
}

const AVAILABLE_STATES = new Set<UpdateStatusType>(['available', 'downloading', 'downloaded'])

export function buildMirroredUpdate(input: MirroredUpdateInput): MirroredUpdate {
  const status = input.status
  const state: MirroredUpdateState = status?.status ?? 'idle'
  const updateDownloaded = input.downloadedVersion !== null
  return {
    supported: input.supported,
    state,
    // A staged update outranks a transient state: a background re-check flips
    // status to 'checking'/'not-available' while the downloaded artifact is
    // still sitting on disk waiting for a restart.
    updateAvailable: updateDownloaded || AVAILABLE_STATES.has(state as UpdateStatusType),
    updateDownloaded,
    currentVersion: input.currentVersion,
    availableVersion: input.downloadedVersion ?? status?.version ?? null,
    percent: state === 'downloading' ? quantizePercent(status?.percent) : null,
    restartPending: input.restartPending,
    message: state === 'error' ? status?.message ?? null : null,
    releaseUrl: status?.releaseUrl ?? null,
  }
}

/**
 * Change key for the mirrored payload. The updater fires on every progress tick
 * and every 30-minute background check; a push is only worth making when one of
 * the fields the web renders actually moved.
 */
export function updateFingerprint(update: MirroredUpdate | null): string {
  if (!update) return ''
  return [
    update.supported ? 'y' : 'n',
    update.state,
    update.updateAvailable ? 'a' : '-',
    update.updateDownloaded ? 'd' : '-',
    update.currentVersion,
    update.availableVersion ?? '-',
    update.percent ?? '-',
    update.restartPending ? 'r' : '-',
    update.message ?? '-',
  ].join('|')
}

export type RestartUpdatePlan =
  | { action: 'install' }
  | { action: 'check'; reason: 'not-downloaded' }
  | { action: 'none'; reason: 'already-restarting' | 'unsupported' }

/**
 * What a remote restartToUpdate command should do.
 *
 * `already-restarting` is the idempotency guard and comes first: the command
 * table is a full-snapshot subscription and the user can tap twice, so the same
 * intent legitimately arrives more than once. A second quitAndInstall() while
 * the first is tearing the app down is exactly the double-restart to avoid.
 */
export function planRestartToUpdate(input: {
  supported: boolean
  downloaded: boolean
  restartPending: boolean
}): RestartUpdatePlan {
  if (input.restartPending) return { action: 'none', reason: 'already-restarting' }
  if (!input.supported) return { action: 'none', reason: 'unsupported' }
  if (!input.downloaded) return { action: 'check', reason: 'not-downloaded' }
  return { action: 'install' }
}
