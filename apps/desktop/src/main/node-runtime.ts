import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'

export interface NodeRuntimeContext {
  execPath: string
  env: NodeJS.ProcessEnv
  versions: NodeJS.ProcessVersions
  platform: NodeJS.Platform
}

const COMMON_NODE_PATHS = [
  '/opt/homebrew/bin/node',
  '/usr/local/bin/node',
  '/usr/bin/node',
]

const COMMON_BINARY_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
]

const CODEX_SCOPE_NAME = '@openai'
const CODEX_PACKAGE_NAME = 'codex'

let cachedResolvedNodeExecPath: string | null = null

function getDefaultContext(): NodeRuntimeContext {
  return {
    execPath: process.execPath,
    env: process.env,
    versions: process.versions,
    platform: process.platform,
  }
}

function isElectronRuntime(context: NodeRuntimeContext): boolean {
  return Boolean(context.versions.electron)
}

function uniqueNonEmpty(values: Array<string | undefined | null>): string[] {
  return values.filter((value, index, entries): value is string => {
    return Boolean(value) && entries.indexOf(value) === index
  })
}

function getPathDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':'
}

function getPathEntries(pathValue: string | undefined, platform: NodeJS.Platform): string[] {
  if (!pathValue) return []
  return pathValue
    .split(getPathDelimiter(platform))
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function getHomeDir(env: NodeJS.ProcessEnv): string | undefined {
  return env.HOME || env.USERPROFILE
}

function getUserBinaryDirs(env: NodeJS.ProcessEnv): string[] {
  const homeDir = getHomeDir(env)
  return uniqueNonEmpty([
    env.BUN_INSTALL ? join(env.BUN_INSTALL, 'bin') : undefined,
    env.NVM_BIN,
    env.VOLTA_HOME ? join(env.VOLTA_HOME, 'bin') : undefined,
    homeDir ? join(homeDir, '.bun', 'bin') : undefined,
    homeDir ? join(homeDir, '.local', 'bin') : undefined,
    homeDir ? join(homeDir, 'bin') : undefined,
  ])
}

function getExecutableNames(command: string, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return [command]
  if (/\.[A-Za-z0-9]+$/.test(command)) return [command]
  return [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`]
}

function getEnvNodeCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates = [
    env.npm_node_execpath,
    env.NODE,
    env.VOLTA_HOME ? join(env.VOLTA_HOME, 'bin', 'node') : undefined,
  ]

  return uniqueNonEmpty(candidates)
}

function resolveNodeFromPath(context: NodeRuntimeContext): string | null {
  const resolver = context.platform === 'win32' ? 'where' : 'which'
  try {
    const value = execFileSync(resolver, ['node'], {
      encoding: 'utf8',
      timeout: 1000,
    }).trim()
    if (value && existsSync(value)) return value
  } catch {}
  return null
}

function getNodePtyProbePath(): string | null {
  try {
    return require.resolve('node-pty')
  } catch {
    return null
  }
}

function canRunNodePty(candidate: string, context: NodeRuntimeContext): boolean {
  if (context.env.ORCHESTRA_NODE_SKIP_PROBE === '1') return true
  if (candidate === context.execPath) return false

  const nodePtyPath = getNodePtyProbePath()
  if (!nodePtyPath) return true

  const shell = context.platform === 'win32' ? (context.env.COMSPEC || 'cmd.exe') : '/bin/sh'
  const probeScript = [
    `const pty = require(${JSON.stringify(nodePtyPath)});`,
    `const shell = ${JSON.stringify(shell)};`,
    `let done = false;`,
    `const finish = (code) => { if (done) return; done = true; process.exit(code); };`,
    `try {`,
    `  const p = pty.spawn(shell, [], {`,
    `    name: 'xterm-256color',`,
    `    cols: 80,`,
    `    rows: 24,`,
    `    cwd: ${JSON.stringify(process.cwd())},`,
    `    env: process.env,`,
    `  });`,
    `  p.onExit(() => finish(0));`,
    `  setTimeout(() => { try { p.kill(); } catch {} finish(0); }, 100);`,
    `} catch (error) {`,
    `  console.error(error && error.message ? error.message : String(error));`,
    `  finish(1);`,
    `}`,
  ].join('\n')

  const result = spawnSync(candidate, ['-e', probeScript], {
    cwd: process.cwd(),
    env: buildNodeChildEnv({
      ORCHESTRA_NODE_SKIP_PROBE: '1',
      ORCHESTRA_NODE_EXEC_PATH: candidate,
    }, context),
    encoding: 'utf8',
    timeout: 1500,
    stdio: 'pipe',
  })

  return result.status === 0
}

export function resolveNodeExecPath(context: NodeRuntimeContext = getDefaultContext()): string {
  const canUseCache =
    context.execPath === process.execPath &&
    context.env === process.env &&
    context.versions === process.versions &&
    context.platform === process.platform

  if (canUseCache && cachedResolvedNodeExecPath) {
    return cachedResolvedNodeExecPath
  }

  if (!isElectronRuntime(context)) {
    return context.execPath
  }

  const explicitNodePath = context.env.ORCHESTRA_NODE_EXEC_PATH
  const fromPath = resolveNodeFromPath(context)
  const candidates = [
    explicitNodePath,
    ...COMMON_NODE_PATHS,
    fromPath,
    ...getEnvNodeCandidates(context.env),
  ].filter((value, index, values): value is string => {
    return Boolean(value) && values.indexOf(value) === index
  })

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    if (canRunNodePty(candidate, context)) {
      if (canUseCache) cachedResolvedNodeExecPath = candidate
      return candidate
    }
  }

  if (canUseCache) cachedResolvedNodeExecPath = context.execPath
  return context.execPath
}

export function buildCliPath(context: NodeRuntimeContext = getDefaultContext()): string {
  const resolvedNodeExecPath = resolveNodeExecPath(context)
  const entries = uniqueNonEmpty([
    resolvedNodeExecPath ? dirname(resolvedNodeExecPath) : undefined,
    ...getUserBinaryDirs(context.env),
    ...getPathEntries(context.env.PATH, context.platform),
    ...COMMON_BINARY_DIRS,
  ])

  return entries.join(getPathDelimiter(context.platform))
}

export function buildShellPath(context: NodeRuntimeContext = getDefaultContext()): string {
  const entries = uniqueNonEmpty([
    ...getUserBinaryDirs(context.env),
    ...getPathEntries(context.env.PATH, context.platform),
    ...COMMON_BINARY_DIRS,
  ])

  return entries.join(getPathDelimiter(context.platform))
}

export function resolveCommandExecPath(
  command: string,
  context: NodeRuntimeContext = getDefaultContext()
): string | null {
  const candidates = getPathEntries(buildCliPath(context), context.platform)
  const executableNames = getExecutableNames(command, context.platform)

  for (const dir of candidates) {
    for (const executableName of executableNames) {
      const candidate = join(dir, executableName)
      if (existsSync(candidate)) return candidate
    }
  }

  return null
}

function resolveCodexPackageRoot(commandPath: string): string | null {
  const resolvedPath = (() => {
    try {
      return realpathSync(commandPath)
    } catch {
      return commandPath
    }
  })()

  const codexBinDir = join(CODEX_SCOPE_NAME, CODEX_PACKAGE_NAME, 'bin')
  if (!resolvedPath.includes(codexBinDir)) {
    return null
  }

  return dirname(dirname(resolvedPath))
}

function resolveCodexBinaryFromVendorRoot(vendorRoot: string, platform: NodeJS.Platform): string | null {
  const binaryName = platform === 'win32' ? 'codex.exe' : 'codex'

  try {
    const triples = readdirSync(vendorRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()

    for (const triple of triples) {
      const candidate = join(vendorRoot, triple, 'codex', binaryName)
      if (existsSync(candidate)) {
        return candidate
      }
    }
  } catch {}

  return null
}

function rankCodexPlatformPackage(name: string, platform: NodeJS.Platform): number {
  const platformToken = platform === 'win32' ? 'win32' : platform
  if (!name.startsWith(`codex-${platformToken}-`)) {
    return Number.MAX_SAFE_INTEGER
  }

  if (name.endsWith(`-${process.arch}`)) {
    return 0
  }

  return 1
}

export function resolveCodexExecPath(context: NodeRuntimeContext = getDefaultContext()): string | null {
  const commandPath = resolveCommandExecPath('codex', context)
  if (!commandPath) return null

  const codexPackageRoot = resolveCodexPackageRoot(commandPath)
  if (!codexPackageRoot) {
    return commandPath
  }

  const localVendorBinary = resolveCodexBinaryFromVendorRoot(
    join(codexPackageRoot, 'vendor'),
    context.platform,
  )
  if (localVendorBinary) {
    return localVendorBinary
  }

  const scopeRoot = dirname(codexPackageRoot)

  try {
    const siblingPackages = readdirSync(scopeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => rankCodexPlatformPackage(left, context.platform) - rankCodexPlatformPackage(right, context.platform))

    for (const siblingPackage of siblingPackages) {
      const vendorBinary = resolveCodexBinaryFromVendorRoot(
        join(scopeRoot, siblingPackage, 'vendor'),
        context.platform,
      )
      if (vendorBinary) {
        return vendorBinary
      }
    }
  } catch {}

  return commandPath
}

export function buildCliChildEnv(
  extraEnv: NodeJS.ProcessEnv = {},
  context: NodeRuntimeContext = getDefaultContext()
): NodeJS.ProcessEnv {
  const env = { ...context.env, ...extraEnv }
  if (!env.HOME && context.platform !== 'win32') {
    env.HOME = homedir()
  }
  if (!env.USER) {
    try {
      env.USER = userInfo().username
    } catch {}
  }
  if (!env.LOGNAME && env.USER) {
    env.LOGNAME = env.USER
  }
  env.PATH = buildCliPath({ ...context, env })
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

export function buildShellChildEnv(
  extraEnv: NodeJS.ProcessEnv = {},
  context: NodeRuntimeContext = getDefaultContext()
): NodeJS.ProcessEnv {
  const env = { ...context.env, ...extraEnv }
  if (!env.HOME && context.platform !== 'win32') {
    env.HOME = homedir()
  }
  if (!env.USER) {
    try {
      env.USER = userInfo().username
    } catch {}
  }
  if (!env.LOGNAME && env.USER) {
    env.LOGNAME = env.USER
  }
  env.PATH = buildShellPath({ ...context, env })
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

export function buildNodeChildEnv(
  extraEnv: NodeJS.ProcessEnv = {},
  context: NodeRuntimeContext = getDefaultContext()
): NodeJS.ProcessEnv {
  const env = { ...context.env, ...extraEnv }
  const targetExecPath = extraEnv.ORCHESTRA_NODE_EXEC_PATH || context.execPath
  if (isElectronRuntime(context) && targetExecPath === context.execPath) {
    env.ELECTRON_RUN_AS_NODE = '1'
  } else {
    delete env.ELECTRON_RUN_AS_NODE
  }
  return env
}
