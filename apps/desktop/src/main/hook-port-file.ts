// Small helper to publish the hook-server port into a well-known file under
// the Orchestra home dir. The daemon reads this at terminal-spawn time and
// injects ORCHESTRA_HOOK_PORT into the child env.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { getOrchestraHomeDir } from './orchestra-paths'

const PORT_FILE_NAME = 'hook-port.txt'

export function getHookPortFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getOrchestraHomeDir(env), PORT_FILE_NAME)
}

export function writeHookPortFile(port: number, env: NodeJS.ProcessEnv = process.env): void {
  const target = getHookPortFilePath(env)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(tmp, String(port), 'utf8')
  fs.renameSync(tmp, target)
}

export function readHookPortFile(env: NodeJS.ProcessEnv = process.env): number | null {
  const target = getHookPortFilePath(env)
  try {
    const raw = fs.readFileSync(target, 'utf8').trim()
    const n = Number.parseInt(raw, 10)
    if (!Number.isFinite(n) || n <= 0 || n > 65535) return null
    return n
  } catch {
    return null
  }
}

export function removeHookPortFile(env: NodeJS.ProcessEnv = process.env): void {
  try {
    fs.unlinkSync(getHookPortFilePath(env))
  } catch {
    // ignore
  }
}
