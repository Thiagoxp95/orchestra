// VoiceManager — owns the Python sidecar lifecycle for the voice feature.
//
//   - `enable()` spawns the sidecar via the configured `spawn` factory, wires
//     up stdout/stderr listeners, and resolves once the child looks alive
//     (~no exit within 2s). The spec calls this "fail-to-spawn" detection.
//   - `disable()` sends a `shutdown` command, then SIGTERM-then-SIGKILL the
//     child if it doesn't exit promptly.
//   - On crash, auto-restarts up to 3 times in 60s with 1s/4s/16s backoff.
//   - Tracks heartbeats; if 3 are missed (>= 6s of silence) the child is
//     killed and restarted. This catches wedged interpreters.
//   - Vocabulary is pushed via stdin JSON `set_vocab` and re-pushed after
//     restarts so the sidecar comes back in sync.
//   - On `matched` events, looks up the action by id in the latest vocabulary
//     and calls the configured `runAction(workspaceId, action)`.
//
// The class is intentionally framework-agnostic — IPC integration lives in
// the main entrypoint, which subscribes via `on('event', ...)` /
// `on('status', ...)`.

import { EventEmitter } from 'node:events'
import type {
  CustomAction,
  VoiceEvent,
  VoiceErrorCode,
  VoiceStatus,
  VoiceVocabularyEntry,
} from '../../shared/types'

// ---------------------------------------------------------------------------
// Sidecar handle abstraction (lets us swap real spawn for FakeSidecar in tests)
// ---------------------------------------------------------------------------

export interface SidecarSpawnOptions {
  wakeWord?: string
  wakeThreshold?: number
  intentThreshold?: number
}

export interface SidecarHandle {
  onEvent(listener: (event: VoiceEvent) => void): void
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
  onStderr(listener: (line: string) => void): void
  send(command: object): void
  kill(signal?: NodeJS.Signals): void
}

export type SidecarFactory = (opts: SidecarSpawnOptions) => SidecarHandle

// ---------------------------------------------------------------------------
// Manager configuration
// ---------------------------------------------------------------------------

export interface RunActionContext {
  workspaceId: string
  action: CustomAction
  text: string
  confidence: number
}

export interface VoiceManagerOptions {
  /** Factory that spawns (or fakes) the Python sidecar. */
  spawn: SidecarFactory

  /**
   * Resolve `actionId` to `{workspaceId, action}` against current state.
   * Returning null forwards the event as `no_match` so deletions cannot
   * crash. Optional — when omitted the manager simply forwards `matched`
   * events to listeners without local dispatch (the renderer-side store
   * handles resolution + runAction in that case).
   */
  resolveAction?: (actionId: string) => { workspaceId: string; action: CustomAction } | null

  /** Dispatcher for matched intents. Same path the footer click uses. */
  runAction?: (ctx: RunActionContext) => void | Promise<void>

  /** Sidecar settings forwarded to the Python child. */
  sidecarOptions?: SidecarSpawnOptions

  /** Mostly useful in tests. Defaults to 6s. */
  heartbeatTimeoutMs?: number

  /** Mostly useful in tests. Defaults to 2s. */
  startupGraceMs?: number

  /** Mostly useful in tests. Defaults to a real-time scheduler. */
  scheduler?: Scheduler

  /** Optional custom logger. Defaults to console. */
  logger?: { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void; log: (...a: unknown[]) => void }

  /** Max stderr lines retained for the Settings → "View sidecar logs" view. */
  stderrBufferSize?: number

  /**
   * Optional gate consulted before each spawn. When provided, returning false
   * prevents the sidecar from being spawned and surfaces a `sidecar_failed_to_spawn`
   * error with a `setup_not_ready` message — letting the renderer drive setup
   * before re-enabling. Used in production to wait for `VoiceSetup.isReady()`.
   */
  requireReady?: () => boolean
}

// ---------------------------------------------------------------------------
// Scheduler abstraction so timer-driven behaviors can be tested with fake timers
// ---------------------------------------------------------------------------

export interface Scheduler {
  setTimeout(callback: () => void, ms: number): { clear: () => void }
  setInterval(callback: () => void, ms: number): { clear: () => void }
  now(): number
}

const realScheduler: Scheduler = {
  setTimeout(callback, ms) {
    const t = setTimeout(callback, ms)
    return {
      clear: () => clearTimeout(t),
    }
  },
  setInterval(callback, ms) {
    const t = setInterval(callback, ms)
    return {
      clear: () => clearInterval(t),
    }
  },
  now() {
    return Date.now()
  },
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_HINT_MS = 2000
const RESTART_WINDOW_MS = 60_000
const MAX_RESTARTS_IN_WINDOW = 3
const RESTART_BACKOFFS_MS = [1000, 4000, 16_000]

export class VoiceManager extends EventEmitter {
  private readonly opts: Required<
    Pick<
      VoiceManagerOptions,
      'heartbeatTimeoutMs' | 'startupGraceMs' | 'scheduler' | 'logger' | 'stderrBufferSize'
    >
  > & VoiceManagerOptions

  private handle: SidecarHandle | null = null
  private vocab: VoiceVocabularyEntry[] = []
  private status: VoiceStatus = { enabled: false, state: 'disabled' }

  private heartbeatTimer: { clear: () => void } | null = null
  private startupTimer: { clear: () => void } | null = null
  private restartTimer: { clear: () => void } | null = null

  /** Times of recent restart attempts; used to enforce the 3-strike policy. */
  private restartAttempts: number[] = []

  /** Set true once the post-startup grace window has passed; arms auto-restart. */
  private startupConfirmed = false

  /** Captured stderr lines, ring-buffered for the Settings dialog. */
  private stderrLines: string[] = []

  constructor(options: VoiceManagerOptions) {
    super()
    this.opts = {
      ...options,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 6000,
      // Parakeet + openWakeWord cold-load takes ~5-6s on Apple Silicon and
      // can stretch longer on first launch / cold filesystem. 2s was wrong.
      startupGraceMs: options.startupGraceMs ?? 15000,
      scheduler: options.scheduler ?? realScheduler,
      logger: options.logger ?? console,
      stderrBufferSize: options.stderrBufferSize ?? 200,
    }
  }

  // ------------------------------------------------------------------ lifecycle

  isEnabled(): boolean {
    return this.handle !== null
  }

  getStatus(): VoiceStatus {
    return { ...this.status }
  }

  getStderrSnapshot(): string[] {
    return this.stderrLines.slice()
  }

  /** Idempotent enable. Resolves once the sidecar has started, or rejects if it dies fast. */
  async enable(): Promise<void> {
    if (this.handle) return
    this.restartAttempts = []
    this.startupConfirmed = false
    await this.doSpawn()
  }

  /** Synchronous, force-kills the sidecar and clears all state. */
  disable(): void {
    this.clearTimers()
    this.restartAttempts = []
    this.startupConfirmed = false
    if (this.handle) {
      try {
        this.handle.send({ type: 'shutdown' })
      } catch {}
      try {
        this.handle.kill('SIGTERM')
      } catch {}
      this.handle = null
    }
    this.updateStatus({ enabled: false, state: 'disabled' })
  }

  /** Push a new vocabulary to the sidecar. Cached for use after restarts. */
  setVocabulary(vocab: VoiceVocabularyEntry[]): void {
    this.vocab = vocab.slice()
    if (this.handle) {
      try {
        this.handle.send({ type: 'set_vocab', vocab: this.vocab })
      } catch (err) {
        this.opts.logger.warn('[voice] failed to push vocab', err)
      }
    }
  }

  // ------------------------------------------------------------------ internal

  private async doSpawn(): Promise<void> {
    if (this.opts.requireReady && !this.opts.requireReady()) {
      this.handle = null
      this.updateStatus({
        enabled: false,
        state: 'error',
        lastError: { code: 'sidecar_failed_to_spawn', message: 'setup_not_ready' },
      })
      return
    }
    let handle: SidecarHandle
    try {
      handle = this.opts.spawn(this.opts.sidecarOptions ?? {})
    } catch (err) {
      this.opts.logger.error('[voice] failed to spawn sidecar', err)
      this.handle = null
      this.updateStatus({
        enabled: false,
        state: 'error',
        lastError: { code: 'sidecar_failed_to_spawn', message: String((err as Error)?.message || err) },
      })
      return
    }

    this.handle = handle
    this.updateStatus({ enabled: true, state: 'starting' })

    handle.onEvent((event) => this.onSidecarEvent(event))
    handle.onStderr((line) => this.onStderrLine(line))
    handle.onExit((code, signal) => this.onSidecarExit(code, signal))

    // Push the cached vocabulary so the sidecar comes up in sync.
    if (this.vocab.length > 0) {
      try {
        handle.send({ type: 'set_vocab', vocab: this.vocab })
      } catch {}
    }

    // Startup grace: if the child exits within this window, treat it as a
    // failed spawn rather than a crash + restart loop.
    this.startupTimer = this.opts.scheduler.setTimeout(() => {
      this.startupConfirmed = true
      this.updateStatus({ enabled: true, state: 'listening' })
      this.armHeartbeatWatchdog()
    }, this.opts.startupGraceMs)
  }

  private onSidecarEvent(event: VoiceEvent): void {
    // Heartbeats reset the watchdog. We accept any inbound event as proof of
    // life (including matched / final / etc) so a busy sidecar doesn't get
    // killed for being too noisy to spend cycles on heartbeats.
    this.armHeartbeatWatchdog()

    if (event.type === 'matched' && this.opts.resolveAction) {
      const resolved = this.opts.resolveAction(event.actionId)
      if (!resolved) {
        this.opts.logger.warn('[voice] matched action_id not found in current vocabulary', event.actionId)
        // Don't forward the matched event; surface it as a no_match so the
        // bubble shows but no action runs. Keeps the renderer state simple.
        this.emit('event', { type: 'no_match', text: event.text } satisfies VoiceEvent)
        return
      }
      if (this.opts.runAction) {
        try {
          const maybe = this.opts.runAction({
            workspaceId: resolved.workspaceId,
            action: resolved.action,
            text: event.text,
            confidence: event.confidence,
          })
          if (maybe && typeof (maybe as Promise<unknown>).then === 'function') {
            ;(maybe as Promise<unknown>).catch((err) => this.opts.logger.error('[voice] runAction rejected', err))
          }
        } catch (err) {
          this.opts.logger.error('[voice] runAction threw', err)
        }
      }
    }

    if (event.type === 'error') {
      this.updateStatus({
        enabled: true,
        state: 'error',
        lastError: { code: event.code, message: event.message },
      })
    }

    this.emit('event', event)
  }

  private onStderrLine(line: string): void {
    if (!line) return
    this.stderrLines.push(line)
    if (this.stderrLines.length > this.opts.stderrBufferSize) {
      this.stderrLines.splice(0, this.stderrLines.length - this.opts.stderrBufferSize)
    }
  }

  private onSidecarExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.clearTimers()
    const previousHandle = this.handle
    this.handle = null
    if (!previousHandle) return // disable() already cleared

    if (!this.startupConfirmed) {
      // Process died during startup grace — treat as fail-to-spawn.
      const code: VoiceErrorCode = 'sidecar_failed_to_spawn'
      this.updateStatus({
        enabled: false,
        state: 'error',
        lastError: { code, message: 'sidecar exited during startup' },
      })
      this.emit('event', { type: 'error', code, message: 'sidecar exited during startup' } satisfies VoiceEvent)
      return
    }

    // Crash mid-run. Apply 3-strikes-in-60s policy.
    const now = this.opts.scheduler.now()
    this.restartAttempts = this.restartAttempts.filter((t) => now - t <= RESTART_WINDOW_MS)
    if (this.restartAttempts.length >= MAX_RESTARTS_IN_WINDOW) {
      this.opts.logger.warn('[voice] sidecar crash exceeded 3 restarts in 60s — giving up')
      this.updateStatus({
        enabled: false,
        state: 'error',
        lastError: {
          code: 'sidecar_crash',
          message: `sidecar exited (code=${code} signal=${signal}) too many times`,
        },
      })
      this.emit('event', {
        type: 'error',
        code: 'sidecar_crash',
        message: 'sidecar restart limit reached',
      } satisfies VoiceEvent)
      return
    }

    const backoff = RESTART_BACKOFFS_MS[this.restartAttempts.length] ?? 16_000
    this.restartAttempts.push(now)
    this.startupConfirmed = false
    this.updateStatus({ enabled: true, state: 'restarting' })
    this.opts.logger.warn(`[voice] sidecar exited (code=${code} signal=${signal}); restarting in ${backoff}ms`)

    this.restartTimer = this.opts.scheduler.setTimeout(() => {
      this.restartTimer = null
      void this.doSpawn()
    }, backoff)
  }

  private armHeartbeatWatchdog(): void {
    this.heartbeatTimer?.clear()
    this.heartbeatTimer = this.opts.scheduler.setTimeout(() => {
      this.heartbeatTimer = null
      this.opts.logger.warn('[voice] heartbeat timeout — restarting sidecar')
      this.emit('event', { type: 'error', code: 'wedged', message: 'heartbeat timeout' } satisfies VoiceEvent)
      const previous = this.handle
      try {
        previous?.kill('SIGKILL')
      } catch {}
      // Treat as a crash for restart accounting. We keep `this.handle`
      // populated so onSidecarExit's "already cleared" guard does not bail.
      this.startupConfirmed = true
      this.onSidecarExit(null, 'SIGKILL')
    }, this.opts.heartbeatTimeoutMs)
  }

  private clearTimers(): void {
    this.heartbeatTimer?.clear()
    this.heartbeatTimer = null
    this.startupTimer?.clear()
    this.startupTimer = null
    this.restartTimer?.clear()
    this.restartTimer = null
  }

  private updateStatus(next: VoiceStatus): void {
    this.status = next
    this.emit('status', next)
  }
}

// Re-export the heartbeat hint so callers in main can match the sidecar's
// 2s emit cadence when picking timeouts.
export const VOICE_HEARTBEAT_INTERVAL_MS = HEARTBEAT_INTERVAL_HINT_MS
