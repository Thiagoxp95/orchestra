// State-machine coverage for VoiceSetup. We feed a scripted runner that
// fakes `which python3.11`, `bash setup.sh`, the parakeet warm-up command,
// and `brew install python@3.11`, and assert the stages emitted on the
// `progress` event match the documented happy paths and retry flow.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { VoiceSetupProgressEvent, VoiceSetupStatus } from '../../shared/types'
import type { SidecarPaths } from './sidecar-paths'
import { VoiceSetup, type VoiceSetupRunner } from './voice-setup'

let fakePaths: SidecarPaths

beforeAll(() => {
  // VoiceSetup uses real fs.existsSync to validate setup.sh / the venv. We
  // give it a real (but empty) setup.sh so the test exercises the runner
  // path rather than the missing-script branch.
  const root = mkdtempSync(join(tmpdir(), 'voice-setup-test-'))
  const sidecar = join(root, 'voice-sidecar')
  mkdirSync(sidecar, { recursive: true })
  writeFileSync(join(sidecar, 'setup.sh'), '#!/usr/bin/env bash\nexit 0\n')
  writeFileSync(join(sidecar, 'main.py'), '# stub\n')
  fakePaths = {
    sidecarDir: sidecar,
    scriptPath: join(sidecar, 'main.py'),
    setupScriptPath: join(sidecar, 'setup.sh'),
    venvDir: join(root, 'voice-venv'),
    venvPython: join(root, 'voice-venv', 'bin', 'python'),
  }
})

interface RunnerScript {
  /** True iff the venv exists at the start. Can be flipped during the test. */
  venvExists: boolean
  hasBrew: boolean
  /** Map "cmd args*" → exit code. Falls back to 0. */
  exits: Record<string, number>
  /** Map "cmd args*" → stdout/stderr lines emitted to onLine. */
  output: Record<string, string[]>
  pythonVersion: string | null
}

function buildRunner(script: RunnerScript): VoiceSetupRunner {
  return {
    async run(cmd, args, { onLine }) {
      const key = `${cmd} ${args.join(' ')}`
      const versionKey = args[0] === '--version' ? `${cmd} --version` : null
      // Python --version probes
      if (versionKey === `${cmd} --version`) {
        if (cmd === 'python3.11' && script.pythonVersion) {
          onLine(script.pythonVersion, 'stdout')
          return { exitCode: 0, stdoutTail: [script.pythonVersion], stderrTail: [] }
        }
        return { exitCode: 1, stdoutTail: [], stderrTail: ['no such command'] }
      }
      const lines = script.output[key] ?? []
      for (const line of lines) onLine(line, 'stdout')
      const exit = key in script.exits ? script.exits[key] : 0
      return { exitCode: exit, stdoutTail: lines, stderrTail: [] }
    },
    async hasCommand(cmd) {
      if (cmd === 'brew') return script.hasBrew
      return true
    },
    venvExists() {
      return script.venvExists
    },
  }
}

function captureProgress(setup: VoiceSetup): { stages: VoiceSetupProgressEvent[] } {
  const stages: VoiceSetupProgressEvent[] = []
  setup.on('progress', (e: VoiceSetupProgressEvent) => stages.push(e))
  return { stages }
}

describe('VoiceSetup', () => {
  it('python missing → install via brew → ready', async () => {
    const script: RunnerScript = {
      venvExists: false,
      hasBrew: true,
      pythonVersion: null, // initial probe fails
      exits: {},
      output: {},
    }
    const runner = buildRunner(script)
    const setup = new VoiceSetup({ runner, paths: fakePaths })
    captureProgress(setup)

    // Step 1: discover that python is missing.
    const first = await setup.runSetup()
    expect(first.stage).toBe('python_missing')
    expect(first.canInstallPython).toBe(true)

    // Now simulate brew install succeeding and python becoming available.
    script.pythonVersion = 'Python 3.11.7'
    const second = await setup.runSetup({ installPython: true })
    expect(second.stage).toBe('ready')
    expect(setup.isReady()).toBe(true)
  })

  it('venv missing → setup.sh succeeds → model downloads → ready', async () => {
    const script: RunnerScript = {
      venvExists: false,
      hasBrew: true,
      pythonVersion: 'Python 3.11.7',
      exits: {},
      output: {
        [`bash ${fakePaths.setupScriptPath}`]: ['[orchestra-voice] Done.'],
      },
    }
    const runner = buildRunner(script)
    const setup = new VoiceSetup({ runner, paths: fakePaths })
    const { stages } = captureProgress(setup)

    const result = await setup.runSetup()
    expect(result.stage).toBe('ready')
    const observed = stages.map((s) => s.stage)
    expect(observed).toContain('checking_python')
    expect(observed).toContain('installing_deps')
    expect(observed).toContain('downloading_model')
    expect(observed).toContain('ready')
  })

  it('pip failure surfaces failed; retry resumes from current state', async () => {
    const script: RunnerScript = {
      venvExists: false,
      hasBrew: true,
      pythonVersion: 'Python 3.11.7',
      exits: {
        [`bash ${fakePaths.setupScriptPath}`]: 1,
      },
      output: {},
    }
    const runner = buildRunner(script)
    const runSpy = vi.spyOn(runner, 'run')
    const setup = new VoiceSetup({ runner, paths: fakePaths })

    // First run fails.
    const failed: VoiceSetupStatus = await setup.runSetup()
    expect(failed.stage).toBe('failed')
    expect(failed.errorCode).toBe('pip_failed')
    expect(failed.canRetry).toBe(true)

    // Fix the script; retry.
    script.exits = {}
    const retry = await setup.runSetup()
    expect(retry.stage).toBe('ready')
    expect(runSpy).toHaveBeenCalled()
  })
})
