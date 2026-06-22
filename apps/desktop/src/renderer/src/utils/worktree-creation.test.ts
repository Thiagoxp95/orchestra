import { describe, expect, it, vi } from 'vitest'
import { runWorktreeCreation, type WorktreeCreationDeps } from './worktree-creation'
import type { CustomAction } from '../../../shared/types'

const fgAction = { id: 'a1', name: 'Deploy', icon: '__terminal__' } as unknown as CustomAction
const bgAction = { id: 'a2', name: 'Lint', icon: '__terminal__', runInBackground: true } as unknown as CustomAction

function makeDeps(overrides: Partial<WorktreeCreationDeps> = {}): WorktreeCreationDeps {
  return {
    workspace: { trees: [{ rootDir: '/repo' }], customActions: [fgAction, bgAction] },
    worktreesDir: '/wt',
    createWorktree: vi.fn().mockResolvedValue({ success: true, path: '/wt/repo/feature' }),
    addWorktree: vi.fn(),
    runAction: vi.fn(),
    runBackgroundAction: vi.fn(),
    createSession: vi.fn(),
    ...overrides,
  }
}

describe('runWorktreeCreation', () => {
  it('adds the worktree, runs selected actions (fg+bg), and spins up the agent on success', async () => {
    const deps = makeDeps()
    const res = await runWorktreeCreation(deps, 'w1', {
      branch: 'feature',
      selectedActionIds: ['a1', 'a2'],
      spinUp: 'claude',
    })
    expect(res).toEqual({ success: true })
    expect(deps.createWorktree).toHaveBeenCalledWith('/repo', 'feature', '/wt')
    expect(deps.addWorktree).toHaveBeenCalledWith('w1', '/wt/repo/feature')
    expect(deps.runAction).toHaveBeenCalledWith('w1', fgAction)
    expect(deps.runBackgroundAction).toHaveBeenCalledWith(bgAction)
    // tree index 1 = the new worktree (main repo is index 0)
    expect(deps.createSession).toHaveBeenCalledWith('w1', 'claude', 'claude', 1)
  })

  it('only runs the selected actions', async () => {
    const deps = makeDeps()
    await runWorktreeCreation(deps, 'w1', { branch: 'b', selectedActionIds: ['a1'], spinUp: null })
    expect(deps.runAction).toHaveBeenCalledWith('w1', fgAction)
    expect(deps.runBackgroundAction).not.toHaveBeenCalled()
    expect(deps.createSession).not.toHaveBeenCalled()
  })

  it('no-ops and returns the error when worktree creation fails', async () => {
    const deps = makeDeps({
      createWorktree: vi.fn().mockResolvedValue({ success: false, error: 'branch exists' }),
    })
    const res = await runWorktreeCreation(deps, 'w1', { branch: 'dup', selectedActionIds: ['a1'], spinUp: 'claude' })
    expect(res).toEqual({ success: false, error: 'branch exists' })
    expect(deps.addWorktree).not.toHaveBeenCalled()
    expect(deps.runAction).not.toHaveBeenCalled()
    expect(deps.createSession).not.toHaveBeenCalled()
  })

  it('maps cursor spinUp to its initial command', async () => {
    const deps = makeDeps()
    await runWorktreeCreation(deps, 'w1', { branch: 'b', selectedActionIds: [], spinUp: 'cursor' })
    expect(deps.createSession).toHaveBeenCalledWith('w1', 'agent --force --model composer-2-fast', 'cursor', 1)
  })
})
