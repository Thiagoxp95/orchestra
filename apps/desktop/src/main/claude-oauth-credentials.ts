// claude-oauth-credentials.ts — Read the OAuth token Claude Code itself stores.
//
// macOS: Keychain entry "Claude Code-credentials" via `security find-generic-password`.
// Linux: ~/.claude/.credentials.json.
// Windows: unsupported (Claude Code has no documented credential location here yet).

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir, userInfo } from 'node:os'

export interface ClaudeOAuthToken {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  subscriptionType?: string
}

const KEYCHAIN_SERVICE = 'Claude Code-credentials'
const KEYCHAIN_TIMEOUT_MS = 3_000

function parseCredentialJson(raw: string): ClaudeOAuthToken | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const wrapper = (parsed as { claudeAiOauth?: unknown }).claudeAiOauth
  if (!wrapper || typeof wrapper !== 'object') return null
  const token = wrapper as Record<string, unknown>
  if (typeof token.accessToken !== 'string' || !token.accessToken) return null
  return {
    accessToken: token.accessToken,
    refreshToken: typeof token.refreshToken === 'string' ? token.refreshToken : undefined,
    expiresAt: typeof token.expiresAt === 'number' ? token.expiresAt : undefined,
    subscriptionType: typeof token.subscriptionType === 'string' ? token.subscriptionType : undefined,
  }
}

function readFromKeychain(): Promise<string | null> {
  const account = userInfo().username
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'],
      { timeout: KEYCHAIN_TIMEOUT_MS },
      (err, stdout) => {
        if (err) return resolve(null)
        const trimmed = stdout.trim()
        resolve(trimmed || null)
      },
    )
  })
}

async function readFromLinuxFile(): Promise<string | null> {
  try {
    return await readFile(join(homedir(), '.claude', '.credentials.json'), 'utf-8')
  } catch {
    return null
  }
}

export async function readClaudeOAuthToken(
  platform: NodeJS.Platform = process.platform,
): Promise<ClaudeOAuthToken | null> {
  let raw: string | null = null
  if (platform === 'darwin') {
    raw = await readFromKeychain()
  } else if (platform === 'linux') {
    raw = await readFromLinuxFile()
  } else {
    return null
  }
  if (!raw) return null
  return parseCredentialJson(raw)
}
