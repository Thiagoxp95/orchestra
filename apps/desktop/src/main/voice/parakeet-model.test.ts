import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PARAKEET_MODEL_ID } from './parakeet-model'

// voice-setup.ts pre-downloads PARAKEET_MODEL_ID and reports 'ready'; the Python
// sidecar loads its own constant. If the two drift, setup succeeds and then the
// first utterance stalls for minutes while parakeet-mlx quietly downloads a
// different ~600MB model — which looks exactly like "voice just doesn't work".
const sidecarMain = join(__dirname, '../../../voice-sidecar/main.py')

describe('parakeet model id', () => {
  it('matches the id the Python sidecar loads', () => {
    const py = readFileSync(sidecarMain, 'utf8')
    const match = py.match(/^PARAKEET_MODEL_ID = "([^"]+)"$/m)
    expect(match, 'PARAKEET_MODEL_ID not found in voice-sidecar/main.py').toBeTruthy()
    expect(match![1]).toBe(PARAKEET_MODEL_ID)
  })

  it('is the English-only v2 model, not the multilingual v3', () => {
    expect(PARAKEET_MODEL_ID).toBe('mlx-community/parakeet-tdt-0.6b-v2')
  })
})
