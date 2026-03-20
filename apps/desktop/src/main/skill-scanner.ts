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
 * Scan a directory for skills using both patterns:
 * 1. Flat .md files at top level (e.g. prd.md, auto-triage.md)
 * 2. SKILL.md files inside subdirectories, recursively (max depth 4)
 *
 * This handles all observed layouts across Claude skills, Claude commands,
 * and Codex skills.
 */
async function scanDir(
  dir: string,
  source: SkillSource,
  scope: SkillScope,
): Promise<SkillEntry[]> {
  if (!(await dirExists(dir))) return []
  const entries: SkillEntry[] = []

  // Collect all skill markdown files (flat + recursive SKILL.md)
  const skillFiles = await findAllSkillFiles(dir)

  for (const filePath of skillFiles) {
    try {
      const content = await readFile(filePath, 'utf-8')
      const fm = parseFrontmatter(content)
      const fallbackName = basename(filePath) === 'SKILL.md'
        ? nameFromPath(filePath, dir)
        : basename(filePath, '.md')
      entries.push({
        id: makeId(filePath),
        name: fm.name || fallbackName,
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

async function findAllSkillFiles(
  dir: string,
  maxDepth: number = 4,
  currentDepth: number = 0,
): Promise<string[]> {
  if (currentDepth > maxDepth) return []
  if (!(await dirExists(dir))) return []
  const results: string[] = []
  try {
    const dirEntries = await readdir(dir, { withFileTypes: true })
    for (const entry of dirEntries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue
      const fullPath = join(dir, entry.name)
      if (entry.isFile()) {
        // Top-level .md files (flat skills/commands)
        if (currentDepth === 0 && entry.name.endsWith('.md')) {
          results.push(fullPath)
        }
        // SKILL.md at any depth (directory-based skills)
        else if (entry.name === 'SKILL.md') {
          results.push(fullPath)
        }
      } else if (entry.isDirectory()) {
        const nested = await findAllSkillFiles(fullPath, maxDepth, currentDepth + 1)
        results.push(...nested)
      }
    }
  } catch {
    // dir not readable
  }
  return results
}

export async function scanSkills(rootDir: string): Promise<SkillEntry[]> {
  const home = homedir()
  const results = await Promise.all([
    // Claude project skills (flat .md + SKILL.md in subdirs)
    scanDir(join(rootDir, '.claude', 'skills'), 'claude-skill', 'project'),
    // Claude project commands (flat .md + SKILL.md in subdirs)
    scanDir(join(rootDir, '.claude', 'commands'), 'claude-command', 'project'),
    // Claude user/global skills
    scanDir(join(home, '.claude', 'skills'), 'claude-skill', 'user'),
    // Claude user/global commands
    scanDir(join(home, '.claude', 'commands'), 'claude-command', 'user'),
    // Codex project skills
    scanDir(join(rootDir, '.agents', 'skills'), 'codex-skill', 'project'),
    // Codex user/global skills
    scanDir(join(home, '.agents', 'skills'), 'codex-skill', 'user'),
  ])

  // Deduplicate by filePath (in case project and user overlap)
  const seen = new Set<string>()
  const deduped: SkillEntry[] = []
  for (const entry of results.flat()) {
    if (seen.has(entry.filePath)) continue
    seen.add(entry.filePath)
    deduped.push(entry)
  }
  return deduped
}

export async function getSkillContent(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}
