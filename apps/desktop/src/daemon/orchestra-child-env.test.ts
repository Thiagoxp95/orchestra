import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { orchestraChildEnv } from './session'

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

  it('only injects the Orchestra session id', () => {
    const result = orchestraChildEnv('sess-abc', { HOME: tmpHome })
    expect(result).toEqual({ ORCHESTRA_SESSION_ID: 'sess-abc' })
  })
})
