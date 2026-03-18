// src/daemon/pty-subprocess.ts
// Standalone Node.js process that wraps a single node-pty instance.
// Communicates with parent daemon via binary framing on stdin/stdout.

import * as pty from 'node-pty'
import { PtyMessageType, writeFrame, createFrameParser, SpawnMessage } from './protocol'

let ptyProcess: pty.IPty | null = null
let ptyPaused = false

// Output batching: coalesce output chunks, flush every 32ms or 128KB
const outputChunks: Buffer[] = []
let outputSize = 0
const BATCH_INTERVAL_MS = 32
const BATCH_MAX_BYTES = 128 * 1024

let batchTimer: ReturnType<typeof setInterval> | null = null

function flushOutput(): void {
  if (outputChunks.length === 0) return
  const payload = Buffer.concat(outputChunks)
  outputChunks.length = 0
  outputSize = 0

  const ok = writeFrame(process.stdout, PtyMessageType.Data, payload)
  if (!ok && ptyProcess && !ptyPaused) {
    ptyPaused = true
    ptyProcess.pause()
  }
}

process.stdout.on('drain', () => {
  if (ptyPaused && ptyProcess) {
    ptyPaused = false
    ptyProcess.resume()
  }
})

function sendError(message: string): void {
  writeFrame(process.stdout, PtyMessageType.Error, Buffer.from(message, 'utf8'))
}

// Handle incoming frames from parent
const parseFrame = createFrameParser((type, payload) => {
  switch (type) {
    case PtyMessageType.Spawn: {
      if (ptyProcess) {
        sendError('PTY already spawned')
        return
      }
      const msg: SpawnMessage = JSON.parse(payload.toString('utf8'))
      try {
        ptyProcess = pty.spawn(msg.file, msg.args, {
          name: 'xterm-256color',
          cols: msg.cols,
          rows: msg.rows,
          cwd: msg.cwd,
          env: {
            ...msg.env,
            COLORTERM: 'truecolor',
            TERM_PROGRAM: 'Orchestra',
          }
        })

        ptyProcess.onData((data) => {
          const buf = Buffer.from(data, 'utf8')
          outputChunks.push(buf)
          outputSize += buf.length
          if (outputSize >= BATCH_MAX_BYTES) flushOutput()
        })

        ptyProcess.onExit(({ exitCode, signal }) => {
          const exitPayload = Buffer.alloc(8)
          exitPayload.writeInt32LE(exitCode ?? -1, 0)
          exitPayload.writeInt32LE(signal ?? 0, 4)
          flushOutput()
          writeFrame(process.stdout, PtyMessageType.Exit, exitPayload)
          ptyProcess = null
        })

        // Send spawned with PID
        const pidPayload = Buffer.alloc(4)
        pidPayload.writeUInt32LE(ptyProcess.pid ?? 0, 0)
        writeFrame(process.stdout, PtyMessageType.Spawned, pidPayload)

        // Start output batching timer
        batchTimer = setInterval(flushOutput, BATCH_INTERVAL_MS)
      } catch (err: any) {
        sendError(`Spawn failed: ${err.message}`)
      }
      break
    }

    case PtyMessageType.Write: {
      if (!ptyProcess) return
      ptyProcess.write(payload.toString('utf8'))
      break
    }

    case PtyMessageType.Resize: {
      if (!ptyProcess) return
      const cols = payload.readUInt32LE(0)
      const rows = payload.readUInt32LE(4)
      try {
        ptyProcess.resize(cols, rows)
      } catch {}
      break
    }

    case PtyMessageType.Kill: {
      if (!ptyProcess) return
      const signal = payload.length > 0 ? payload.toString('utf8') : 'SIGTERM'
      ptyProcess.kill(signal)
      break
    }

    case PtyMessageType.Signal: {
      if (!ptyProcess) return
      const sig = payload.toString('utf8')
      ptyProcess.kill(sig)
      break
    }

    case PtyMessageType.Dispose: {
      if (ptyProcess) {
        ptyProcess.kill('SIGKILL')
        ptyProcess = null
      }
      if (batchTimer) clearInterval(batchTimer)
      process.exit(0)
    }
  }
})

// Read binary frames from stdin
process.stdin.on('data', (chunk: Buffer) => {
  parseFrame(chunk)
})

process.stdin.on('end', () => {
  if (ptyProcess) ptyProcess.kill('SIGKILL')
  if (batchTimer) clearInterval(batchTimer)
  process.exit(0)
})

// Tell parent we're ready
writeFrame(process.stdout, PtyMessageType.Ready, Buffer.alloc(0))
