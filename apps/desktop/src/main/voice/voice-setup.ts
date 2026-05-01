// VoiceSetup — drives a state machine that provisions the voice sidecar's
// Python environment, dependencies, and speech model on the user's machine.
//
// The state machine flows through the following stages, in order:
//
//   unknown
//     → checking_python
//         → python_missing  (terminal until brew-install requested)
//         → venv_missing
//             → installing_deps  (runs setup.sh, streams pip output)
//                 → downloading_model  (forces parakeet-mlx HF download)
//                     → ready
//
// At any point a step can fail and transition to `failed` — the renderer
// can then call `runSetup()` again to retry.
//
// All long-running shell operations stream progress to listeners so the UI
// can surface live status. We never run sudo and never silently install
// system Python; brew is invoked only when the renderer explicitly opts in
// via `runSetup({ installPython: true })`.

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import type {
  VoiceSetupProgressEvent,
  VoiceSetupStage,
  VoiceSetupStatus,
} from '../../shared/types'
import { resolveSidecarPaths, type SidecarPaths } from './sidecar-paths'

export interface VoiceSetupSpawnResult {
  exitCode: number | null
  stdoutTail: string[]
  stderrTail: string[]
}

export interface VoiceSetupRunner {
  /** Run a command, streaming lines to onLine. Resolves with exit code + tails. */
  run(
    cmd: string,
    args: string[],
    opts: {
      onLine: (line: string, stream: 'stdout' | 'stderr') => void
      env?: NodeJS.ProcessEnv
    }
  ): Promise<VoiceSetupSpawnResult>
  /** True iff `which <cmd>` would resolve. */
  hasCommand(cmd: string): Promise<boolean>
  /** True iff a venv exists with a usable python. */
  venvExists(paths: SidecarPaths): boolean
}

const defaultRunner: VoiceSetupRunner = {
  async run(cmd, args, { onLine, env }) {
    return new Promise<VoiceSetupSpawnResult>((resolve) => {
      const child = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: env ?? process.env,
      })
      const stdoutTail: string[] = []
      const stderrTail: string[] = []
      const pushTail = (arr: string[], line: string) => {
        arr.push(line)
        if (arr.length > 200) arr.splice(0, arr.length - 200)
      }
      let stdoutBuf = ''
      let stderrBuf = ''
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf8')
        let idx: number
        while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, idx)
          stdoutBuf = stdoutBuf.slice(idx + 1)
          if (line) {
            pushTail(stdoutTail, line)
            onLine(line, 'stdout')
          }
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString('utf8')
        let idx: number
        while ((idx = stderrBuf.indexOf('\n')) >= 0) {
          const line = stderrBuf.slice(0, idx)
          stderrBuf = stderrBuf.slice(idx + 1)
          if (line) {
            pushTail(stderrTail, line)
            onLine(line, 'stderr')
          }
        }
      })
      child.on('error', (err) => {
        pushTail(stderrTail, `spawn error: ${err.message}`)
        resolve({ exitCode: null, stdoutTail, stderrTail })
      })
      child.on('exit', (code) => {
        if (stdoutBuf) {
          pushTail(stdoutTail, stdoutBuf)
          onLine(stdoutBuf, 'stdout')
        }
        if (stderrBuf) {
          pushTail(stderrTail, stderrBuf)
          onLine(stderrBuf, 'stderr')
        }
        resolve({ exitCode: code, stdoutTail, stderrTail })
      })
    })
  },
  async hasCommand(cmd) {
    const result = await this.run('/usr/bin/which', [cmd], { onLine: () => {} })
    return result.exitCode === 0
  },
  venvExists(paths) {
    return existsSync(paths.venvPython)
  },
}

export interface VoiceSetupOptions {
  runner?: VoiceSetupRunner
  paths?: SidecarPaths
  logger?: { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void }
}

export class VoiceSetup extends EventEmitter {
  private status: VoiceSetupStatus = {
    stage: 'unknown',
    canRetry: true,
    canInstallPython: false,
  }
  private inFlight: Promise<VoiceSetupStatus> | null = null
  private resolvedPython: string | null = null
  private readonly runner: VoiceSetupRunner
  private readonly paths: SidecarPaths

  constructor(options: VoiceSetupOptions = {}) {
    super()
    this.runner = options.runner ?? defaultRunner
    this.paths = options.paths ?? resolveSidecarPaths()
    void options.logger
  }

  getStatus(): VoiceSetupStatus {
    return { ...this.status }
  }

  isReady(): boolean {
    return this.status.stage === 'ready'
  }

  /** Resolve to whichever python binary the venv uses (after a successful run). */
  getResolvedPython(): string | null {
    return this.resolvedPython
  }

  /**
   * Drives the state machine forward to `ready`, or returns the failure status.
   * Idempotent: a second concurrent call returns the same in-flight promise.
   */
  async runSetup(opts: { installPython?: boolean } = {}): Promise<VoiceSetupStatus> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.doRun(opts).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  // -------------------------------------------------------- internal helpers

  private emitProgress(stage: VoiceSetupStage, message: string, progress?: number): void {
    const event: VoiceSetupProgressEvent = { stage, message, progress }
    this.emit('progress', event)
  }

  private setStatus(next: VoiceSetupStatus): VoiceSetupStatus {
    this.status = next
    return next
  }

  private async doRun(opts: { installPython?: boolean }): Promise<VoiceSetupStatus> {
    // 1. checking_python
    this.setStatus({ stage: 'checking_python', canRetry: true, canInstallPython: false })
    this.emitProgress('checking_python', 'Looking for Python 3.11+...')
    const python = await this.findPython()
    if (!python) {
      // Offer brew install, or fail if installPython requested but brew missing
      const hasBrew = await this.runner.hasCommand('brew')
      if (opts.installPython) {
        if (!hasBrew) {
          return this.setStatus({
            stage: 'python_missing',
            errorCode: 'no_brew',
            message: 'Homebrew not found. Install Homebrew or Python 3.11 manually, then retry.',
            canRetry: true,
            canInstallPython: false,
          })
        }
        this.emitProgress('python_missing', 'Installing Python 3.11 via Homebrew (this can take a few minutes)...')
        const brewResult = await this.runner.run('brew', ['install', 'python@3.11'], {
          onLine: (line) => this.emitProgress('python_missing', line),
        })
        if (brewResult.exitCode !== 0) {
          return this.setStatus({
            stage: 'python_missing',
            errorCode: 'brew_install_failed',
            message: brewResult.stderrTail.slice(-3).join('\n') || 'brew install python@3.11 failed',
            canRetry: true,
            canInstallPython: hasBrew,
          })
        }
        // Re-discover after install.
        const after = await this.findPython()
        if (!after) {
          return this.setStatus({
            stage: 'python_missing',
            errorCode: 'python_not_on_path_after_install',
            message: 'brew finished but python3.11 is still not on PATH. Open a new terminal or check brew shellenv.',
            canRetry: true,
            canInstallPython: false,
          })
        }
        this.resolvedPython = after
      } else {
        return this.setStatus({
          stage: 'python_missing',
          errorCode: hasBrew ? undefined : 'no_brew',
          message: hasBrew
            ? 'Python 3.11+ not found. Click Install to provision via Homebrew.'
            : 'Python 3.11+ not found and Homebrew is not installed. Install Python manually and retry.',
          canRetry: true,
          canInstallPython: hasBrew,
        })
      }
    } else {
      this.resolvedPython = python
    }

    // 2. venv_missing → installing_deps
    if (!this.runner.venvExists(this.paths)) {
      this.setStatus({ stage: 'venv_missing', canRetry: true, canInstallPython: false })
      this.emitProgress('venv_missing', 'Voice environment missing — running setup script...')
    }

    this.setStatus({ stage: 'installing_deps', canRetry: true, canInstallPython: false })
    this.emitProgress('installing_deps', 'Installing Python dependencies (parakeet-mlx, openwakeword)...')
    const setupEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ORCHESTRA_VOICE_PYTHON: this.resolvedPython ?? 'python3.11',
      ORCHESTRA_VOICE_VENV: this.paths.venvDir,
    }
    if (!existsSync(this.paths.setupScriptPath)) {
      return this.setStatus({
        stage: 'failed',
        errorCode: 'setup_script_missing',
        message: `Voice sidecar setup.sh not found at ${this.paths.setupScriptPath}.`,
        canRetry: true,
        canInstallPython: false,
      })
    }
    const setupResult = await this.runner.run('bash', [this.paths.setupScriptPath], {
      onLine: (line) => this.emitProgress('installing_deps', line),
      env: setupEnv,
    })
    if (setupResult.exitCode !== 0) {
      return this.setStatus({
        stage: 'failed',
        errorCode: 'pip_failed',
        message: setupResult.stderrTail.slice(-5).join('\n') || 'setup.sh failed',
        canRetry: true,
        canInstallPython: false,
      })
    }

    // 3. downloading_model — force HF download with visible progress.
    this.setStatus({ stage: 'downloading_model', canRetry: true, canInstallPython: false })
    this.emitProgress('downloading_model', 'Downloading speech recognition model (~600MB, first run only)...')
    const modelResult = await this.runner.run(
      this.paths.venvPython,
      [
        '-c',
        "import parakeet_mlx; m = parakeet_mlx.from_pretrained('mlx-community/parakeet-tdt-0.6b-v2'); print('ok')",
      ],
      {
        onLine: (line) => this.emitProgress('downloading_model', line),
      }
    )
    if (modelResult.exitCode !== 0) {
      return this.setStatus({
        stage: 'failed',
        errorCode: 'model_download_failed',
        message: modelResult.stderrTail.slice(-5).join('\n') || 'parakeet-mlx model download failed',
        canRetry: true,
        canInstallPython: false,
      })
    }

    // 4. ready
    this.emitProgress('ready', 'Voice environment ready.')
    return this.setStatus({
      stage: 'ready',
      message: 'Voice environment ready.',
      canRetry: false,
      canInstallPython: false,
    })
  }

  /** Locate a python>=3.11 binary; returns absolute path or null. */
  private async findPython(): Promise<string | null> {
    const candidates = ['python3.11', 'python3.12', 'python3.13', 'python3']
    for (const candidate of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const versionResult = await this.runner.run(candidate, ['--version'], { onLine: () => {} })
      if (versionResult.exitCode !== 0) continue
      const versionLine = [...versionResult.stdoutTail, ...versionResult.stderrTail].join(' ')
      const match = /Python (\d+)\.(\d+)/.exec(versionLine)
      if (!match) continue
      const major = Number(match[1])
      const minor = Number(match[2])
      if (major > 3 || (major === 3 && minor >= 11)) return candidate
    }
    return null
  }
}
