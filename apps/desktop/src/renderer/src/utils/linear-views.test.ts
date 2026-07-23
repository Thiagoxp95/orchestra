import { describe, expect, test } from 'vitest'
import type { LinearCustomView } from '../../../shared/linear-types'
import { filterIssuesByView, sortViewsByStar, toggleStarredView } from './linear-views'

function view(id: string, name: string): LinearCustomView {
  return { id, name, description: null, color: null, team: null }
}

describe('sortViewsByStar', () => {
  test('puts starred views first, each group alphabetical', () => {
    const views = [view('a', 'All Bugs'), view('m', 'My Issues'), view('c', 'Current Cycle'), view('d', 'Design Review')]
    const sorted = sortViewsByStar(views, ['m', 'c'])
    expect(sorted.map((v) => v.name)).toEqual(['Current Cycle', 'My Issues', 'All Bugs', 'Design Review'])
    expect(sorted.map((v) => v.starred)).toEqual([true, true, false, false])
  })

  test('falls back to alphabetical with no stars', () => {
    const sorted = sortViewsByStar([view('b', 'Beta'), view('a', 'Alpha')])
    expect(sorted.map((v) => v.name)).toEqual(['Alpha', 'Beta'])
  })

  test('ignores starred ids that no longer exist', () => {
    const sorted = sortViewsByStar([view('a', 'Alpha')], ['deleted-view'])
    expect(sorted.map((v) => v.starred)).toEqual([false])
  })

  test('does not mutate the input array', () => {
    const views = [view('b', 'Beta'), view('a', 'Alpha')]
    sortViewsByStar(views, ['a'])
    expect(views.map((v) => v.id)).toEqual(['b', 'a'])
  })
})

describe('toggleStarredView', () => {
  test('adds then removes', () => {
    expect(toggleStarredView([], 'v1')).toEqual(['v1'])
    expect(toggleStarredView(['v1', 'v2'], 'v1')).toEqual(['v2'])
  })

  test('treats a missing list as empty', () => {
    expect(toggleStarredView(undefined, 'v1')).toEqual(['v1'])
  })
})

describe('filterIssuesByView', () => {
  const issues = [
    { id: '1', linearViewIds: ['v1'] },
    { id: '2', linearViewIds: ['v1', 'v2'] },
    { id: '3', linearViewIds: undefined },
  ]

  test('returns everything when no view is active', () => {
    expect(filterIssuesByView(issues, undefined).map((i) => i.id)).toEqual(['1', '2', '3'])
  })

  test('keeps only issues stamped with the active view', () => {
    expect(filterIssuesByView(issues, 'v2').map((i) => i.id)).toEqual(['2'])
  })

  test('hides unstamped issues while a view is active', () => {
    expect(filterIssuesByView(issues, 'v1').map((i) => i.id)).toEqual(['1', '2'])
  })
})
