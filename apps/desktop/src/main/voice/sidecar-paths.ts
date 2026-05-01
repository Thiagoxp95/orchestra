// Shared path resolution for the Python voice sidecar.
//
// In dev (`!app.isPackaged`), this file is compiled to
// `out/main/...` and run from the repo root, but the source `voice-sidecar/`
// directory ships under `apps/desktop/voice-sidecar/`. We walk up from
// `__dirname` looking for `apps/desktop/voice-sidecar/main.py`, with a
// process.cwd() fallback that matches `electron-vite dev` behaviour.
//
// In packaged builds, the sidecar is copied into `process.resourcesPath`
// via `electron-builder.yml` extraResources.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface SidecarPaths {
  /** Absolute path to the voice-sidecar/ directory containing main.py / setup.sh / pyproject.toml. */
  sidecarDir: string
  /** Absolute path to main.py. */
  scriptPath: string
  /** Absolute path to setup.sh. */
  setupScriptPath: string
  /** Absolute path to the venv root (~/.orchestra/voice-venv by default). */
  venvDir: string
  /** Absolute path to the venv's python binary (may not yet exist). */
  venvPython: string
}

function findSidecarDir(): string {
  if (process.env.ORCHESTRA_VOICE_SIDECAR_DIR) return process.env.ORCHESTRA_VOICE_SIDECAR_DIR

  // Packaged: process.resourcesPath/voice-sidecar
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resources) {
    const packaged = join(resources, 'voice-sidecar')
    if (existsSync(join(packaged, 'main.py'))) return packaged
  }

  // Dev: walk up from __dirname to find apps/desktop/voice-sidecar/main.py
  const candidates: string[] = []
  let cur = __dirname
  for (let i = 0; i < 8; i++) {
    candidates.push(join(cur, 'apps', 'desktop', 'voice-sidecar'))
    candidates.push(join(cur, 'voice-sidecar'))
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  candidates.push(join(process.cwd(), 'apps', 'desktop', 'voice-sidecar'))
  candidates.push(join(process.cwd(), 'voice-sidecar'))

  for (const c of candidates) {
    if (existsSync(join(c, 'main.py'))) return c
  }

  // Last-ditch fallback so callers don't crash; the file probably won't exist.
  return join(process.cwd(), 'apps', 'desktop', 'voice-sidecar')
}

export function resolveSidecarPaths(): SidecarPaths {
  const sidecarDir = findSidecarDir()
  const venvDir = process.env.ORCHESTRA_VOICE_VENV ?? join(homedir(), '.orchestra', 'voice-venv')
  return {
    sidecarDir,
    scriptPath: process.env.ORCHESTRA_VOICE_SCRIPT ?? join(sidecarDir, 'main.py'),
    setupScriptPath: join(sidecarDir, 'setup.sh'),
    venvDir,
    venvPython: join(venvDir, 'bin', 'python'),
  }
}
