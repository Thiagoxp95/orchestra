import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { orchestraChildEnv } from './session'
import { writeHookPortFile } from '../main/hook-port-file'

describe('orchestraChildEnv', () => {
  let tmpHome: string

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-childenv-'))
  })
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('always sets ORCHESTRA_SESSION_ID', () => {
    const result = orchestraChildEnv('sess-abc', { HOME: tmpHome })
    expect(result.ORCHESTRA_SESSION_ID).toBe('sess-abc')
  })

  it('omits ORCHESTRA_HOOK_PORT when no port file is published', () => {
    const result = orchestraChildEnv('sess-abc', { HOME: tmpHome })
    expect(result.ORCHESTRA_HOOK_PORT).toBeUndefined()
  })

  it('sets ORCHESTRA_HOOK_PORT as a string when the port file is present', () => {
    writeHookPortFile(45678, { HOME: tmpHome })
    const result = orchestraChildEnv('sess-abc', { HOME: tmpHome })
    expect(result.ORCHESTRA_HOOK_PORT).toBe('45678')
    expect(typeof result.ORCHESTRA_HOOK_PORT).toBe('string')
  })

  it('returns only ORCHESTRA_SESSION_ID when the port file contains an invalid value', () => {
    const portFilePath = path.join(tmpHome, '.orchestra', 'hook-port.txt')
    fs.mkdirSync(path.dirname(portFilePath), { recursive: true })
    fs.writeFileSync(portFilePath, 'not-a-number')
    const result = orchestraChildEnv('sess-abc', { HOME: tmpHome })
    expect(Object.keys(result)).toEqual(['ORCHESTRA_SESSION_ID'])
  })
})
