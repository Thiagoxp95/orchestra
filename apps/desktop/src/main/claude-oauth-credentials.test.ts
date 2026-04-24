import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mocks are hoisted, so we must reference them through vi.mock factories.
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}))

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { readClaudeOAuthToken } from './claude-oauth-credentials'

const mockedExecFile = execFile as unknown as ReturnType<typeof vi.fn>
const mockedReadFile = readFile as unknown as ReturnType<typeof vi.fn>

function mockKeychain(value: string | Error): void {
  mockedExecFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    if (value instanceof Error) {
      cb(value, '', 'not found')
    } else {
      cb(null, value, '')
    }
  })
}

function mockFile(value: string | Error): void {
  if (value instanceof Error) {
    mockedReadFile.mockRejectedValueOnce(value)
  } else {
    mockedReadFile.mockResolvedValueOnce(value)
  }
}

const SAMPLE_TOKEN = {
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-abc',
    refreshToken: 'sk-ant-ort01-def',
    expiresAt: 1900000000000,
    subscriptionType: 'max',
  },
}

describe('readClaudeOAuthToken', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('on macOS (platform=darwin)', () => {
    it('returns parsed credential from Keychain', async () => {
      mockKeychain(JSON.stringify(SAMPLE_TOKEN))

      const token = await readClaudeOAuthToken('darwin')
      expect(token).toEqual({
        accessToken: 'sk-ant-oat01-abc',
        refreshToken: 'sk-ant-ort01-def',
        expiresAt: 1900000000000,
        subscriptionType: 'max',
      })
    })

    it('returns null when Keychain entry is missing', async () => {
      mockKeychain(new Error('security: SecKeychainSearchCopyNext: The specified item could not be found'))

      const token = await readClaudeOAuthToken('darwin')
      expect(token).toBeNull()
    })

    it('returns null when Keychain output is malformed JSON', async () => {
      mockKeychain('not-json')

      const token = await readClaudeOAuthToken('darwin')
      expect(token).toBeNull()
    })

    it('returns null when JSON has no claudeAiOauth wrapper', async () => {
      mockKeychain(JSON.stringify({ other: 'shape' }))

      const token = await readClaudeOAuthToken('darwin')
      expect(token).toBeNull()
    })

    it('does not read the filesystem fallback', async () => {
      mockKeychain(JSON.stringify(SAMPLE_TOKEN))

      await readClaudeOAuthToken('darwin')
      expect(mockedReadFile).not.toHaveBeenCalled()
    })
  })

  describe('on Linux (platform=linux)', () => {
    it('returns parsed credential from ~/.claude/.credentials.json', async () => {
      mockFile(JSON.stringify(SAMPLE_TOKEN))

      const token = await readClaudeOAuthToken('linux')
      expect(token?.accessToken).toBe('sk-ant-oat01-abc')
    })

    it('returns null when credentials file is missing', async () => {
      mockFile(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

      const token = await readClaudeOAuthToken('linux')
      expect(token).toBeNull()
    })

    it('returns null on malformed JSON', async () => {
      mockFile('{broken')

      const token = await readClaudeOAuthToken('linux')
      expect(token).toBeNull()
    })

    it('does not invoke the keychain binary', async () => {
      mockFile(JSON.stringify(SAMPLE_TOKEN))

      await readClaudeOAuthToken('linux')
      expect(mockedExecFile).not.toHaveBeenCalled()
    })
  })

  describe('on unsupported platforms', () => {
    it('returns null for win32', async () => {
      const token = await readClaudeOAuthToken('win32')
      expect(token).toBeNull()
      expect(mockedExecFile).not.toHaveBeenCalled()
      expect(mockedReadFile).not.toHaveBeenCalled()
    })
  })
})
