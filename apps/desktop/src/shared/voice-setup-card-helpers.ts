// Pure helpers for deciding whether a "voice setup incomplete" reminder
// card should appear in the sidebar. Mirrors the visibility model used by
// `getVisibleUpdateCardState` for the auto-update card.
//
// Visibility rules:
//   * Hidden when voice has never been attempted AND not currently enabled —
//     the user hasn't expressed interest, so don't pester.
//   * Hidden when setup is fully ready.
//   * Hidden when the user dismissed the card and the current stage is not
//     `failed` — failures explicitly resurface the reminder.
//   * Otherwise: visible, with a friendly message + severity.
//
// The `failed` and `python_missing` stages are treated as errors (red).
// All other in-flight stages are treated as informational (the user is in
// the middle of provisioning and just needs to come back to the wizard).

import type { VoiceSetupStage, VoiceSetupStatus } from './types'

export type VoiceSetupCardSeverity = 'info' | 'warn' | 'error'

export interface VoiceSetupCardState {
  stage: VoiceSetupStage
  message: string
  severity: VoiceSetupCardSeverity
}

export interface VoiceSetupCardVisibilityInput {
  voiceEnabled: boolean
  setupStatus: VoiceSetupStatus | null
  /** Has the user ever opened the wizard? Persisted via electron-store. */
  setupAttempted: boolean
  /** Has the user dismissed the card for this run? Resets on each fresh failure. */
  dismissed: boolean
}

const STAGE_LABELS: Record<VoiceSetupStage, string> = {
  unknown: 'Voice setup not finished yet.',
  checking_python: 'Checking for Python 3.11+…',
  python_missing: 'Python 3.11+ is required.',
  venv_missing: 'Preparing the Python environment…',
  installing_deps: 'Installing dependencies…',
  downloading_model: 'Downloading speech models…',
  ready: 'Voice is ready.',
  failed: 'Voice setup failed.',
}

function severityFor(stage: VoiceSetupStage): VoiceSetupCardSeverity {
  if (stage === 'failed') return 'error'
  if (stage === 'python_missing') return 'warn'
  return 'info'
}

export function getVisibleVoiceSetupCardState(
  input: VoiceSetupCardVisibilityInput,
): VoiceSetupCardState | null {
  const { voiceEnabled, setupStatus, setupAttempted, dismissed } = input
  const stage: VoiceSetupStage = setupStatus?.stage ?? 'unknown'

  // All good — never show the reminder.
  if (stage === 'ready') return null

  // User dismissed and nothing is broken — stay hidden.
  if (dismissed && stage !== 'failed') return null

  // Concrete in-flight or broken setup state → always show, regardless of
  // whether we ever caught the `setupAttempted` flag (it can fail to persist
  // if the user closed the wizard quickly). This is the "you started setup,
  // come back and finish it" path.
  const concreteStage = stage !== 'unknown'
  if (concreteStage) {
    return {
      stage,
      message: setupStatus?.message?.trim() || STAGE_LABELS[stage],
      severity: severityFor(stage),
    }
  }

  // No concrete signal yet. Only nudge if the user has expressed intent
  // (toggled voice.enabled or opened the wizard at least once).
  if (!voiceEnabled && !setupAttempted) return null

  return {
    stage,
    message: setupStatus?.message?.trim() || STAGE_LABELS[stage],
    severity: severityFor(stage),
  }
}
