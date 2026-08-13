import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, dirname, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import type { SkillEntry, SkillSource, SkillScope } from '../shared/types'

function makeId(filePath: string): string {
  return createHash('sha256').update(filePath).digest('hex').slice(0, 12)
}

function parseFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!match) return {}
  const block = match[1]
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '')
  const description = block.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '')
  return { name, description }
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path)
    return s.isDirectory()
  } catch {
    return false
  }
}

/** Derive a human-readable skill name from its SKILL.md path relative to the skills root */
function nameFromPath(skillMdPath: string, skillsRoot: string): string {
  const rel = relative(skillsRoot, dirname(skillMdPath))
  // e.g. "gstack/browse" → "gstack/browse", "triage-issue" → "triage-issue"
  return rel || dirname(skillMdPath).split('/').pop() || 'unknown'
}

/**
 * How a root directory names the things inside it:
 *
 * - `skills`  — a skill is a directory holding SKILL.md (plus reference material
 *   that is NOT itself a skill), or a flat .md at the top level. The name comes
 *   from frontmatter.
 * - `commands` — EVERY .md is a command, at any depth, and the FILE PATH is the
 *   name: `.claude/commands/desktop/dev.md` is invoked as `/desktop:dev`.
 *   Frontmatter `name` is not the invocation name here, so it is ignored.
 */
type DirLayout = 'skills' | 'commands'

/** `<root>/desktop/dev.md` → "desktop:dev" — claude's namespacing for nested commands. */
function commandNameFromPath(filePath: string, root: string): string {
  return relative(root, filePath).replace(/\.md$/, '').split('/').join(':')
}

/**
 * Scan a directory for skills/commands. Handles all observed layouts across
 * Claude skills, Claude commands, and Codex skills.
 */
export async function scanDir(
  dir: string,
  source: SkillSource,
  scope: SkillScope,
  layout: DirLayout = 'skills',
): Promise<SkillEntry[]> {
  if (!(await dirExists(dir))) return []
  const entries: SkillEntry[] = []

  const skillFiles = await findAllSkillFiles(dir, layout)

  for (const filePath of skillFiles) {
    try {
      const content = await readFile(filePath, 'utf-8')
      const fm = parseFrontmatter(content)
      const fallbackName = basename(filePath) === 'SKILL.md'
        ? nameFromPath(filePath, dir)
        : basename(filePath, '.md')
      const name = layout === 'commands'
        ? commandNameFromPath(filePath, dir)
        : fm.name || fallbackName
      entries.push({
        id: makeId(filePath),
        name,
        description: fm.description || '',
        source,
        scope,
        filePath,
      })
    } catch {
      // skip unreadable
    }
  }
  return entries
}

/**
 * Directory entries, resolving symlinks. `readdir(withFileTypes)` reports a
 * symlink as neither file nor directory, and skill libraries are commonly
 * installed as symlink farms (`~/.claude/skills/<name>` → `~/.agents/skills/<name>`),
 * so trusting the dirent kind alone silently skipped whole catalogs — the whole
 * reason the phone's autocomplete only ever offered built-ins.
 */
async function readEntries(dir: string): Promise<Array<{ path: string; name: string; isDir: boolean }>> {
  const out: Array<{ path: string; name: string; isDir: boolean }> = []
  const dirEntries = await readdir(dir, { withFileTypes: true })
  for (const entry of dirEntries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue
    const fullPath = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      try {
        const s = await stat(fullPath) // follows the link
        out.push({ path: fullPath, name: entry.name, isDir: s.isDirectory() })
      } catch {
        // dangling link
      }
    } else {
      out.push({ path: fullPath, name: entry.name, isDir: entry.isDirectory() })
    }
  }
  return out
}

async function findAllSkillFiles(
  dir: string,
  layout: DirLayout = 'skills',
  maxDepth: number = 4,
  currentDepth: number = 0,
): Promise<string[]> {
  if (currentDepth > maxDepth) return []
  if (!(await dirExists(dir))) return []
  const results: string[] = []
  try {
    for (const entry of await readEntries(dir)) {
      if (!entry.isDir) {
        if (!entry.name.endsWith('.md')) continue
        // Commands: every .md is one, at any depth. Skills: only the top-level
        // flat ones plus SKILL.md, so a skill's reference/*.md stays out.
        if (layout === 'commands' || currentDepth === 0 || entry.name === 'SKILL.md') {
          results.push(entry.path)
        }
      } else {
        results.push(...(await findAllSkillFiles(entry.path, layout, maxDepth, currentDepth + 1)))
      }
    }
  } catch {
    // dir not readable
  }
  return results
}

/**
 * Scan installed Claude Code plugins for skills and commands.
 * Reads ~/.claude/plugins/installed_plugins.json and scans each plugin's
 * skills/ and commands/ directories.
 */
async function scanPlugins(): Promise<SkillEntry[]> {
  const home = homedir()
  const pluginsFile = join(home, '.claude', 'plugins', 'installed_plugins.json')
  try {
    const raw = await readFile(pluginsFile, 'utf-8')
    const data = JSON.parse(raw) as {
      plugins: Record<string, Array<{ installPath: string }>>
    }
    const scans: Promise<SkillEntry[]>[] = []
    for (const [key, installations] of Object.entries(data.plugins)) {
      // key format: "pluginName@marketplace" — extract plugin name as prefix
      const pluginName = key.split('@')[0]
      for (const install of installations) {
        const base = install.installPath
        // Scan skills/ and commands/ within the plugin install path
        scans.push(
          scanDir(join(base, 'skills'), 'claude-plugin', 'user').then((entries) =>
            entries.map((e) => ({
              ...e,
              name: `${pluginName}:${e.name}`,
            })),
          ),
        )
        scans.push(
          scanDir(join(base, 'commands'), 'claude-plugin', 'user', 'commands').then((entries) =>
            entries.map((e) => ({
              ...e,
              name: `${pluginName}:${e.name}`,
            })),
          ),
        )
      }
    }
    return (await Promise.all(scans)).flat()
  } catch {
    return []
  }
}

function dedupeByPath(entries: SkillEntry[]): SkillEntry[] {
  const seen = new Set<string>()
  const out: SkillEntry[] = []
  for (const entry of entries) {
    if (seen.has(entry.filePath)) continue
    seen.add(entry.filePath)
    out.push(entry)
  }
  return out
}

/** Everything available in every repo: user-level skills/commands + installed plugins. */
export async function scanUserSkills(): Promise<SkillEntry[]> {
  const home = homedir()
  const results = await Promise.all([
    scanDir(join(home, '.claude', 'skills'), 'claude-skill', 'user'),
    scanDir(join(home, '.claude', 'commands'), 'claude-command', 'user', 'commands'),
    scanDir(join(home, '.agents', 'skills'), 'codex-skill', 'user'),
    scanPlugins(),
  ])
  return dedupeByPath(results.flat())
}

/**
 * Codex's own user-level command surface: the skills it shares with claude via
 * ~/.agents/skills, its private ~/.codex/skills, and ~/.codex/prompts — the
 * direct analogue of ~/.claude/commands, where every .md is invocable as
 * `/name`. Kept out of scanUserSkills so the skills drawer and the phone's
 * mirrored catalog keep the exact contents they have today.
 */
export async function scanCodexUserCommands(): Promise<SkillEntry[]> {
  const home = homedir()
  const results = await Promise.all([
    scanDir(join(home, '.agents', 'skills'), 'codex-skill', 'user'),
    scanDir(join(home, '.codex', 'skills'), 'codex-skill', 'user'),
    scanDir(join(home, '.codex', 'prompts'), 'codex-skill', 'user', 'commands'),
  ])
  return dedupeByPath(results.flat())
}

/** The per-repo half of the same. */
export async function scanCodexProjectCommands(rootDir: string): Promise<SkillEntry[]> {
  const results = await Promise.all([
    scanDir(join(rootDir, '.agents', 'skills'), 'codex-skill', 'project'),
    scanDir(join(rootDir, '.codex', 'prompts'), 'codex-skill', 'project', 'commands'),
  ])
  return dedupeByPath(results.flat())
}

/** Only what this repo checks in — the half that changes per workspace. */
export async function scanProjectSkills(rootDir: string): Promise<SkillEntry[]> {
  const results = await Promise.all([
    scanDir(join(rootDir, '.claude', 'skills'), 'claude-skill', 'project'),
    scanDir(join(rootDir, '.claude', 'commands'), 'claude-command', 'project', 'commands'),
    scanDir(join(rootDir, '.agents', 'skills'), 'codex-skill', 'project'),
  ])
  return dedupeByPath(results.flat())
}

export async function scanSkills(rootDir: string): Promise<SkillEntry[]> {
  const [project, user] = await Promise.all([scanProjectSkills(rootDir), scanUserSkills()])
  return dedupeByPath([...project, ...user])
}

export async function getSkillContent(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}
