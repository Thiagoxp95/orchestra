import { describe, expect, it } from 'vitest'
import { extractLinearIdentifier, buildLinkedBranchName, slugifyForBranch } from './linear-branch'

describe('buildLinkedBranchName', () => {
  it('embeds the identifier so extractLinearIdentifier round-trips', () => {
    const name = buildLinkedBranchName('feat/add-linear-icon', 'ENG-4504')
    expect(extractLinearIdentifier(name)).toBe('ENG-4504')
  })

  it('drops a leading conventional-commit type prefix', () => {
    expect(buildLinkedBranchName('feat/add-linear-icon', 'ENG-42')).toBe('eng-42-add-linear-icon')
  })

  it('leaves an already-linked branch unchanged', () => {
    expect(buildLinkedBranchName('tedy/eng-42-thing', 'ENG-42')).toBe('tedy/eng-42-thing')
  })

  it('falls back to the title slug for a detached/empty branch', () => {
    const name = buildLinkedBranchName('', 'ENG-7', 'add-linear-icon')
    expect(name).toBe('eng-7-add-linear-icon')
    expect(extractLinearIdentifier(name)).toBe('ENG-7')
  })

  it('uses the bare identifier when there is nothing else', () => {
    expect(buildLinkedBranchName('', 'ENG-9')).toBe('eng-9')
    expect(extractLinearIdentifier('eng-9')).toBe('ENG-9')
  })
})

describe('slugifyForBranch', () => {
  it('lowercases, hyphenates and trims', () => {
    expect(slugifyForBranch('Add a Linear Icon!')).toBe('add-a-linear-icon')
  })

  it('caps length', () => {
    expect(slugifyForBranch('x'.repeat(100)).length).toBeLessThanOrEqual(48)
  })
})
