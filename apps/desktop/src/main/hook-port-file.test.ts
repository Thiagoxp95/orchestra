import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { getHookPortFilePath, writeHookPortFile, readHookPortFile } from './hook-port-file'

describe('hook-port-file', () => {
  let tmpHome: string

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-hookport-'))
  })

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('derives the path from the Orchestra home dir', () => {
    const p = getHookPortFilePath({ HOME: tmpHome })
    expect(p).toBe(path.join(tmpHome, '.orchestra', 'hook-port.txt'))
  })

  it('writes the port atomically and reads it back', () => {
    writeHookPortFile(45678, { HOME: tmpHome })
    expect(readHookPortFile({ HOME: tmpHome })).toBe(45678)
  })

  it('returns null when the file is missing', () => {
    expect(readHookPortFile({ HOME: tmpHome })).toBe(null)
  })

  it('returns null when the file is not a valid port', () => {
    const p = getHookPortFilePath({ HOME: tmpHome })
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, 'not-a-number')
    expect(readHookPortFile({ HOME: tmpHome })).toBe(null)
  })
})
