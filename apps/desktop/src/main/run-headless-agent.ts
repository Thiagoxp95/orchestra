import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { buildAutomationCommand } from '../shared/action-utils'
import { createClaudeStreamRenderer } from '../shared/claude-stream-renderer'
import { AUTOMATION_IDLE_TIMEOUT_MS } from './schedule-computation'
import { PtyMessageType, writeFrame, createFrameParser, type SpawnMessage } from '../daemon/protocol'
import { resolveNodeExecPath, buildShellChildEnv, buildNodeChildEnv } from './node-runtime'
import { buildGitSigningGuardEnv } from './git-signing-guard'
import type { CustomAction } from '../shared/types'

const MAX_OUTPUT = 512 * 1024

/**
 * Run a one-shot headless Claude agent (`claude -p ... --output-format stream-json`)
 * in `cwd` with a real TTY — the same pty-subprocess path automations use — render
 * its stream to plain text, and resolve that text when the process exits. The agent
 * can run git/read files itself. Idle-killed after AUTOMATION_IDLE_TIMEOUT_MS of
 * silence (the stream-json events are the liveness signal). Rejects on spawn error
 * or a non-zero exit that produced no output.
 */
export function runHeadlessAgent(cwd: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const command = buildAutomationCommand({ actionType: 'claude', command: prompt } as CustomAction)
    if (!command) {
      reject(new Error('failed to build claude command'))
      return
    }

    const nodeExecPath = resolveNodeExecPath()
    const subprocessPath = join(__dirname, 'pty-subprocess.js')
    const child = spawn(nodeExecPath, [subprocessPath], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: buildNodeChildEnv({ ORCHESTRA_NODE_EXEC_PATH: nodeExecPath }),
    })

    let output = ''
    let settled = false
    const appendOutput = (text: string): void => {
      if (output.length < MAX_OUTPUT) output += text
    }
    const streamRenderer = createClaudeStreamRenderer(appendOutput)

    let idleTimer: ReturnType<typeof setTimeout>
    const armIdle = (): void => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        try { child.kill('SIGTERM') } catch { /* already gone */ }
      }, AUTOMATION_IDLE_TIMEOUT_MS)
    }
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(idleTimer)
      streamRenderer.flush()
      fn()
    }

    const parseFrame = createFrameParser((type, payload) => {
      switch (type) {
        case PtyMessageType.Ready: {
          const shell = process.env.SHELL || '/bin/sh'
          // Same env shaping as automation agent runs: source the login shell (API
          // keys / PATH), guard git signing, keep background subagents alive.
          const env = buildShellChildEnv(
            buildGitSigningGuardEnv({ SHELL: shell, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' }),
          ) as Record<string, string>
          const msg: SpawnMessage = { file: shell, args: ['-i', '-l', '-c', command], cwd, cols: 120, rows: 40, env }
          writeFrame(child.stdin!, PtyMessageType.Spawn, Buffer.from(JSON.stringify(msg)))
          break
        }
        case PtyMessageType.Data:
          armIdle()
          streamRenderer.write(payload.toString('utf8'))
          break
        case PtyMessageType.Exit: {
          const code = payload.readInt32LE(0)
          finish(() => {
            if (code === 0 || output.trim()) resolve(output)
            else reject(new Error(`headless agent exited ${code} with no output`))
          })
          break
        }
        case PtyMessageType.Error:
          // Surfaced via the exit path; nothing to do here.
          break
      }
    })

    armIdle()
    child.stdout!.on('data', (chunk: Buffer) => parseFrame(chunk))
    child.on('exit', () => finish(() => (output.trim() ? resolve(output) : reject(new Error('headless agent exited unexpectedly')))))
    child.on('error', (err) => finish(() => reject(err)))
  })
}
