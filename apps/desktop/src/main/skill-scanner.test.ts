import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanProjectSkills } from './skill-scanner'

let root = ''

async function write(relPath: string, content: string): Promise<void> {
  const full = join(root, relPath)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, content)
}

describe('scanProjectSkills', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'skill-scan-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('names a nested command by its path, the way claude invokes it', async () => {
    await write('.claude/commands/desktop/dev.md', '---\ndescription: Start the app\n---\nrun it')
    await write('.claude/commands/ship.md', '---\ndescription: Ship it\n---\ngo')
    const found = await scanProjectSkills(root)
    expect(found.map((e) => e.name).sort()).toEqual(['desktop:dev', 'ship'])
    expect(found.find((e) => e.name === 'desktop:dev')?.description).toBe('Start the app')
  })

  it('follows symlinked skill directories', async () => {
    // How skill libraries are actually installed: ~/.claude/skills/<name> is a
    // link into another tree. readdir reports those as neither file nor dir.
    const real = join(root, 'library', 'triage')
    await mkdir(real, { recursive: true })
    await writeFile(join(real, 'SKILL.md'), '---\nname: triage\ndescription: Triage issues\n---\n')
    await mkdir(join(root, '.claude', 'skills'), { recursive: true })
    await symlink(real, join(root, '.claude', 'skills', 'triage'))

    const found = await scanProjectSkills(root)
    expect(found.map((e) => e.name)).toEqual(['triage'])
    expect(found[0].description).toBe('Triage issues')
  })

  it('keeps a skill’s reference material out of the catalog', async () => {
    await write('.claude/skills/writing/SKILL.md', '---\nname: writing\ndescription: Write\n---\n')
    await write('.claude/skills/writing/reference.md', '# not a skill')
    const found = await scanProjectSkills(root)
    expect(found.map((e) => e.name)).toEqual(['writing'])
  })
})
