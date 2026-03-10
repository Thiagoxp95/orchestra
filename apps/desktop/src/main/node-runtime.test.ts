import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as childProcess from 'node:child_process'
import {
  buildCliChildEnv,
  buildCliPath,
  buildNodeChildEnv,
  resolveCommandExecPath,
  resolveNodeExecPath,
  type NodeRuntimeContext,
} from './node-runtime'

function createContext(overrides: Partial<NodeRuntimeContext> = {}): NodeRuntimeContext {
  return {
    execPath: '/runtime/current',
    env: { ORCHESTRA_NODE_SKIP_PROBE: '1' },
    versions: {} as NodeJS.ProcessVersions,
    platform: 'darwin',
    ...overrides,
  }
}

describe('resolveNodeExecPath', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the current runtime when already running under plain Node', () => {
    expect(resolveNodeExecPath(createContext())).toBe('/runtime/current')
  })

  it('prefers an explicit Orchestra node path under Electron', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((path) => path === '/custom/node')

    expect(resolveNodeExecPath(createContext({
      execPath: '/Applications/Electron',
      env: { ORCHESTRA_NODE_EXEC_PATH: '/custom/node' },
      versions: { electron: '33.4.11' } as NodeJS.ProcessVersions,
    }))).toBe('/custom/node')
  })

  it('falls back to node on PATH under Electron', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((path) => path === '/Users/txp/.nvm/versions/node/v22.21.0/bin/node')
    vi.spyOn(childProcess, 'execFileSync').mockImplementation(((file: string, args: string[]) => {
      if (file === 'which' && args[0] === 'node') {
        return '/Users/txp/.nvm/versions/node/v22.21.0/bin/node\n'
      }
      throw new Error('unexpected command')
    }) as typeof childProcess.execFileSync)

    expect(resolveNodeExecPath(createContext({
      execPath: '/Applications/Electron',
      versions: { electron: '33.4.11' } as NodeJS.ProcessVersions,
    }))).toBe('/Users/txp/.nvm/versions/node/v22.21.0/bin/node')
  })

  it('prefers node on PATH over package-manager node hints', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((path) => {
      return path === '/usr/local/bin/node' || path === '/Users/txp/.nvm/versions/node/v22.21.0/bin/node'
    })
    vi.spyOn(childProcess, 'execFileSync').mockImplementation(((file: string, args: string[]) => {
      if (file === 'which' && args[0] === 'node') {
        return '/usr/local/bin/node\n'
      }
      throw new Error('unexpected command')
    }) as typeof childProcess.execFileSync)

    expect(resolveNodeExecPath(createContext({
      execPath: '/Applications/Electron',
      env: { npm_node_execpath: '/Users/txp/.nvm/versions/node/v22.21.0/bin/node' },
      versions: { electron: '33.4.11' } as NodeJS.ProcessVersions,
    }))).toBe('/usr/local/bin/node')
  })

  it('falls back to the current runtime when no standalone node binary is available', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    vi.spyOn(childProcess, 'execFileSync').mockImplementation((() => {
      throw new Error('node not found')
    }) as typeof childProcess.execFileSync)

    expect(resolveNodeExecPath(createContext({
      execPath: '/Applications/Electron',
      versions: { electron: '33.4.11' } as NodeJS.ProcessVersions,
    }))).toBe('/Applications/Electron')
  })
})

describe('buildNodeChildEnv', () => {
  it('drops ELECTRON_RUN_AS_NODE before spawning children', () => {
    const env = buildNodeChildEnv(
      { ORCHESTRA_NODE_EXEC_PATH: '/custom/node' },
      createContext({
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          PATH: '/usr/bin',
        },
      })
    )

    expect(env).toEqual({
      PATH: '/usr/bin',
      ORCHESTRA_NODE_EXEC_PATH: '/custom/node',
    })
  })
})

describe('buildCliPath', () => {
  it('prepends common user install directories for Finder-launched apps', () => {
    expect(buildCliPath(createContext({
      env: {
        HOME: '/Users/txp',
        PATH: '/usr/bin:/bin',
      },
    }))).toBe('/Users/txp/.bun/bin:/Users/txp/.local/bin:/Users/txp/bin:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin')
  })
})

describe('resolveCommandExecPath', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('finds executables in augmented user bin directories', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((path) => path === '/Users/txp/.bun/bin/codex')

    expect(resolveCommandExecPath('codex', createContext({
      env: {
        HOME: '/Users/txp',
        PATH: '/usr/bin:/bin',
      },
    }))).toBe('/Users/txp/.bun/bin/codex')
  })
})

describe('buildCliChildEnv', () => {
  it('augments PATH and drops ELECTRON_RUN_AS_NODE', () => {
    const env = buildCliChildEnv(
      {},
      createContext({
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          HOME: '/Users/txp',
          PATH: '/usr/bin:/bin',
        },
      })
    )

    expect(env).toEqual({
      HOME: '/Users/txp',
      PATH: '/Users/txp/.bun/bin:/Users/txp/.local/bin:/Users/txp/bin:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin',
    })
  })
})
