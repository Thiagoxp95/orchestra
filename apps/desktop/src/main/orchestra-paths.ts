import { join } from 'node:path'

export function isOrchestraDevEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const nodeEnv = env.NODE_ENV?.trim().toLowerCase()
  const electronFlag = env.ELECTRON_IS_DEV?.trim().toLowerCase()
  return nodeEnv === 'development' || electronFlag === '1' || electronFlag === 'true'
}

export function getOrchestraHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const homeDir = env.HOME || env.USERPROFILE || process.env.HOME || process.env.USERPROFILE || ''
  return join(homeDir, `.orchestra${isOrchestraDevEnv(env) ? '-dev' : ''}`)
}

export function getOrchestraBinDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getOrchestraHomeDir(env), 'bin')
}

export function getOrchestraHooksDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getOrchestraHomeDir(env), 'hooks')
}

// The app's live hook-listener ports, rewritten on every listener bind. The
// port stamped into a PTY's env is only correct for the app run that spawned
// it — every restart (auto-updates restart daily) binds a new OS-assigned
// port, while sessions live on in the daemon. The notify scripts re-read these
// files on every hook fire, so sessions spawned by ANY earlier app run keep
// reporting to the current one; the env copy is their fallback.
export function getClaudeHookPortPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getOrchestraHomeDir(env), 'claude-hook-port')
}

export function getCodexHookPortPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getOrchestraHomeDir(env), 'codex-hook-port')
}

export function getCursorHookPortPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getOrchestraHomeDir(env), 'cursor-hook-port')
}
