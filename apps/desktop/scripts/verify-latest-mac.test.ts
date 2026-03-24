import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const SCRIPT_PATH = join(process.cwd(), 'apps/desktop/scripts/verify-latest-mac.rb')

function sha512Base64(text: string): string {
  return createHash('sha512').update(text).digest('base64')
}

describe('verify-latest-mac.rb', () => {
  it('passes when the asset matches the updater metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-latest-mac-'))
    try {
      const assetPath = join(dir, 'Orchestra-0.6.6-mac-arm64.zip')
      const contents = 'valid release asset'
      writeFileSync(assetPath, contents)

      const ymlPath = join(dir, 'latest-mac.yml')
      writeFileSync(ymlPath, [
        'version: 0.6.6',
        'files:',
        '- url: Orchestra-0.6.6-mac-arm64.zip',
        `  sha512: ${sha512Base64(contents)}`,
        `  size: ${Buffer.byteLength(contents)}`,
        'path: Orchestra-0.6.6-mac-arm64.zip',
      ].join('\n'))

      const result = spawnSync('ruby', [SCRIPT_PATH, '--yaml', ymlPath, '--asset', assetPath], { encoding: 'utf8' })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('verified')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails when the asset does not match the updater metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-latest-mac-'))
    try {
      const assetPath = join(dir, 'Orchestra-0.6.6-mac-arm64.zip')
      writeFileSync(assetPath, 'actual asset bytes')

      const ymlPath = join(dir, 'latest-mac.yml')
      writeFileSync(ymlPath, [
        'version: 0.6.6',
        'files:',
        '- url: Orchestra-0.6.6-mac-arm64.zip',
        `  sha512: ${sha512Base64('different bytes')}`,
        `  size: ${Buffer.byteLength('different bytes')}`,
        'path: Orchestra-0.6.6-mac-arm64.zip',
      ].join('\n'))

      const result = spawnSync('ruby', [SCRIPT_PATH, '--yaml', ymlPath, '--asset', assetPath], { encoding: 'utf8' })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('sha512 mismatch')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
