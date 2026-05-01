// Test double for the Python voice sidecar. Implements the `SidecarHandle`
// contract so VoiceManager can talk to it without spawning Python.
//
// Tests drive it like:
//
//     const fake = new FakeSidecar()
//     manager = new VoiceManager({ spawn: () => fake, runAction, ... })
//     await manager.enable()
//     fake.emit({ type: 'matched', actionId: 'abc', text: 'ship', confidence: 1 })
//
// `commands` records every JSON command pushed via stdin so tests can assert
// vocab updates, shutdown, etc.

import type { VoiceEvent } from '../../shared/types'
import type { SidecarHandle, SidecarSpawnOptions } from './voice-manager'

/** A captured command sent from VoiceManager to the sidecar. */
export type FakeSidecarCommand =
  | { type: 'set_vocab'; vocab: unknown }
  | { type: 'shutdown' }
  | { type: string; [key: string]: unknown }

export class FakeSidecar implements SidecarHandle {
  public readonly commands: FakeSidecarCommand[] = []
  public killed = false
  public killSignal: NodeJS.Signals | undefined
  public stderrBuffer: string[] = []

  private eventListeners: Array<(event: VoiceEvent) => void> = []
  private exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  private stderrListeners: Array<(line: string) => void> = []

  // Test-only flag so tests can assert simulated spawn failure.
  public spawnFailed = false

  constructor(_options: SidecarSpawnOptions = {}) {}

  onEvent(listener: (event: VoiceEvent) => void): void {
    this.eventListeners.push(listener)
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners.push(listener)
  }

  onStderr(listener: (line: string) => void): void {
    this.stderrListeners.push(listener)
  }

  send(command: object): void {
    this.commands.push(command as FakeSidecarCommand)
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.killed) return
    this.killed = true
    this.killSignal = signal
  }

  // ---- Test helpers ----

  /** Emit a sidecar event upstream to the manager. */
  emit(event: VoiceEvent): void {
    for (const listener of this.eventListeners) listener(event)
  }

  /** Simulate the Python process exiting. */
  simulateExit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.killed = true
    for (const listener of this.exitListeners) listener(code, signal)
  }

  /** Push a stderr line through to listeners. */
  emitStderr(line: string): void {
    this.stderrBuffer.push(line)
    for (const listener of this.stderrListeners) listener(line)
  }

  /** Returns all `set_vocab` payloads recorded so far. */
  vocabPushes(): unknown[] {
    return this.commands
      .filter((c) => c.type === 'set_vocab')
      .map((c) => (c as { type: 'set_vocab'; vocab: unknown }).vocab)
  }
}
