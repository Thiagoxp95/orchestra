import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as childProcess from 'node:child_process'

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readdirSync: vi.fn(actual.readdirSync),
    realpathSync: vi.fn(actual.realpathSync),
  }
})

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return {
    ...actual,
    execFileSync: vi.fn(actual.execFileSync),
    spawnSync: vi.fn(actual.spawnSync),
  }
})

const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
const actualChildProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process')

import {
  buildCliChildEnv,
  buildCliPath,
  buildNodeChildEnv,
  resolveCodexExecPath,
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
    vi.mocked(fs.existsSync).mockImplementation(actualFs.existsSync)
    vi.mocked(fs.readdirSync).mockImplementation(actualFs.readdirSync as typeof fs.readdirSync)
    vi.mocked(fs.realpathSync).mockImplementation(actualFs.realpathSync as typeof fs.realpathSync)
    vi.mocked(childProcess.execFileSync).mockImplementation(actualChildProcess.execFileSync as typeof childProcess.execFileSync)
    vi.mocked(childProcess.spawnSync).mockImplementation(actualChildProcess.spawnSync as typeof childProcess.spawnSync)
    vi.clearAllMocks()
  })

  it('returns the current runtime when already running under plain Node', () => {
    expect(resolveNodeExecPath(createContext())).toBe('/runtime/current')
  })

  it('prefers an explicit Orchestra node path under Electron', () => {
    vi.mocked(fs.existsSync).mockImplementation((path) => path === '/custom/node')

    expect(resolveNodeExecPath(createContext({
      execPath: '/Applications/Electron',
      env: {
        ORCHESTRA_NODE_EXEC_PATH: '/custom/node',
        ORCHESTRA_NODE_SKIP_PROBE: '1',
      },
      versions: { electron: '33.4.11' } as NodeJS.ProcessVersions,
    }))).toBe('/custom/node')
  })

  it('falls back to node on PATH under Electron', () => {
    vi.mocked(fs.existsSync).mockImplementation((path) => path === '/Users/txp/.nvm/versions/node/v22.21.0/bin/node')
    vi.mocked(childProcess.execFileSync).mockImplementation(((file: string, args: string[]) => {
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
    vi.mocked(fs.existsSync).mockImplementation((path) => {
      return path === '/usr/local/bin/node' || path === '/Users/txp/.nvm/versions/node/v22.21.0/bin/node'
    })
    vi.mocked(childProcess.execFileSync).mockImplementation(((file: string, args: string[]) => {
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
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(childProcess.execFileSync).mockImplementation((() => {
      throw new Error('node not found')
    }) as typeof childProcess.execFileSync)

    expect(resolveNodeExecPath(createContext({
      execPath: '/Applications/Electron',
      versions: { electron: '33.4.11' } as NodeJS.ProcessVersions,
    }))).toBe('/Applications/Electron')
  })
})

describe('buildNodeChildEnv', () => {
  it('sets ELECTRON_RUN_AS_NODE when spawning the Electron runtime as Node', () => {
    const env = buildNodeChildEnv(
      { ORCHESTRA_NODE_EXEC_PATH: '/Applications/Electron' },
      createContext({
        env: {
          PATH: '/usr/bin',
        },
        execPath: '/Applications/Electron',
        versions: { electron: '33.4.11' } as NodeJS.ProcessVersions,
      })
    )

    expect(env).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      PATH: '/usr/bin',
      ORCHESTRA_NODE_EXEC_PATH: '/Applications/Electron',
    })
  })

  it('drops ELECTRON_RUN_AS_NODE when spawning a standalone node binary', () => {
    const env = buildNodeChildEnv(
      { ORCHESTRA_NODE_EXEC_PATH: '/custom/node' },
      createContext({
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          PATH: '/usr/bin',
        },
        execPath: '/Applications/Electron',
        versions: { electron: '33.4.11' } as NodeJS.ProcessVersions,
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
    }))).toBe('/runtime:/Users/txp/.orchestra/bin:/Users/txp/.bun/bin:/Users/txp/.local/bin:/Users/txp/bin:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin')
  })

  it('does not prepend the Orchestra wrapper bin on Windows', () => {
    const result = buildCliPath(createContext({
      platform: 'win32',
      env: {
        USERPROFILE: 'C:\\Users\\txp',
        PATH: 'C:\\Windows\\System32;C:\\Windows',
      },
    }))

    expect(result).not.toContain('.orchestra/bin')
    expect(result).toContain('C:\\Windows\\System32')
  })
})

describe('resolveCommandExecPath', () => {
  afterEach(() => {
    vi.mocked(fs.existsSync).mockImplementation(actualFs.existsSync)
    vi.clearAllMocks()
  })

  it('finds executables in augmented user bin directories', () => {
    vi.mocked(fs.existsSync).mockImplementation((path) => path === '/Users/txp/.bun/bin/codex')

    expect(resolveCommandExecPath('codex', createContext({
      env: {
        HOME: '/Users/txp',
        PATH: '/usr/bin:/bin',
      },
    }))).toBe('/Users/txp/.bun/bin/codex')
  })
})

describe('resolveCodexExecPath', () => {
  afterEach(() => {
    vi.mocked(fs.existsSync).mockImplementation(actualFs.existsSync)
    vi.mocked(fs.readdirSync).mockImplementation(actualFs.readdirSync as typeof fs.readdirSync)
    vi.mocked(fs.realpathSync).mockImplementation(actualFs.realpathSync as typeof fs.realpathSync)
    vi.clearAllMocks()
  })

  it('prefers a resolved vendor binary next to the global codex package', () => {
    vi.mocked(fs.existsSync).mockImplementation((path) => {
      return path === '/Users/txp/.bun/bin/codex'
        || path === '/Users/txp/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex'
    })
    vi.mocked(fs.realpathSync).mockImplementation((path) => {
      if (path === '/Users/txp/.bun/bin/codex') {
        return '/Users/txp/node_modules/@openai/codex/bin/codex.js'
      }
      return path as string
    })
    vi.mocked(fs.readdirSync).mockImplementation((((dir: string) => {
      if (dir === '/Users/txp/node_modules/@openai/codex/vendor') {
        throw new Error('missing local vendor')
      }
      if (dir === '/Users/txp/node_modules/@openai') {
        return [
          { name: 'codex', isDirectory: () => true },
          { name: 'codex-darwin-arm64', isDirectory: () => true },
        ]
      }
      if (dir === '/Users/txp/node_modules/@openai/codex-darwin-arm64/vendor') {
        return [{ name: 'aarch64-apple-darwin', isDirectory: () => true }]
      }
      throw new Error(`unexpected dir ${dir}`)
    }) as unknown) as typeof fs.readdirSync)

    expect(resolveCodexExecPath(createContext({
      env: {
        HOME: '/Users/txp',
        PATH: '/usr/bin:/bin',
      },
    }))).toBe('/Users/txp/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex')
  })

  it('falls back to the codex wrapper when no vendor binary is found', () => {
    vi.mocked(fs.existsSync).mockImplementation((path) => path === '/Users/txp/.bun/bin/codex')
    vi.mocked(fs.realpathSync).mockImplementation((path) => {
      if (path === '/Users/txp/.bun/bin/codex') {
        return '/Users/txp/node_modules/@openai/codex/bin/codex.js'
      }
      return path as string
    })
    vi.mocked(fs.readdirSync).mockImplementation((() => {
      throw new Error('no vendor dirs')
    }) as typeof fs.readdirSync)

    expect(resolveCodexExecPath(createContext({
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
      LOGNAME: 'txp',
      PATH: '/runtime:/Users/txp/.orchestra/bin:/Users/txp/.bun/bin:/Users/txp/.local/bin:/Users/txp/bin:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin',
      USER: 'txp',
    })
  })
})
