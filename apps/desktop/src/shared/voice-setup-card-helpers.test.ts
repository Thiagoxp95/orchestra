import { describe, it, expect } from 'vitest'
import { getVisibleVoiceSetupCardState } from './voice-setup-card-helpers'
import type { VoiceSetupStatus } from './types'

function status(partial: Partial<VoiceSetupStatus>): VoiceSetupStatus {
  return {
    stage: 'unknown',
    canRetry: false,
    canInstallPython: false,
    ...partial,
  }
}

describe('getVisibleVoiceSetupCardState', () => {
  it('hides the card when stage is ready', () => {
    expect(
      getVisibleVoiceSetupCardState({
        voiceEnabled: true,
        setupAttempted: true,
        dismissed: false,
        setupStatus: status({ stage: 'ready' }),
      }),
    ).toBeNull()
  })

  it('hides the card when the user has never attempted setup', () => {
    expect(
      getVisibleVoiceSetupCardState({
        voiceEnabled: false,
        setupAttempted: false,
        dismissed: false,
        setupStatus: status({ stage: 'installing_deps' }),
      }),
    ).toBeNull()
  })

  it('hides the card when dismissed during a non-failed in-flight stage', () => {
    expect(
      getVisibleVoiceSetupCardState({
        voiceEnabled: false,
        setupAttempted: true,
        dismissed: true,
        setupStatus: status({ stage: 'installing_deps' }),
      }),
    ).toBeNull()
  })

  it('keeps the card visible on a failed stage even when dismissed', () => {
    const result = getVisibleVoiceSetupCardState({
      voiceEnabled: false,
      setupAttempted: true,
      dismissed: true,
      setupStatus: status({ stage: 'failed', message: 'pip blew up' }),
    })
    expect(result).not.toBeNull()
    expect(result?.severity).toBe('error')
    expect(result?.message).toBe('pip blew up')
  })

  it('shows the card on a fresh failure', () => {
    const result = getVisibleVoiceSetupCardState({
      voiceEnabled: false,
      setupAttempted: true,
      dismissed: false,
      setupStatus: status({ stage: 'failed' }),
    })
    expect(result).not.toBeNull()
    expect(result?.stage).toBe('failed')
    expect(result?.severity).toBe('error')
  })

  it('falls back to the stage label when message is empty', () => {
    const result = getVisibleVoiceSetupCardState({
      voiceEnabled: true,
      setupAttempted: true,
      dismissed: false,
      setupStatus: status({ stage: 'downloading_model' }),
    })
    expect(result?.message).toMatch(/speech models/i)
  })
})
