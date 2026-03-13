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
