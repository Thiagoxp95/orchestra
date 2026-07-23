import type { LinearCustomView } from '../../../shared/linear-types'

export interface StarrableView extends LinearCustomView {
  starred: boolean
}

/**
 * Order the view picker: starred views first, then the rest, each group sorted
 * by name. Stars live in Orchestra (linearConfig.starredViewIds), not Linear.
 */
export function sortViewsByStar(views: LinearCustomView[], starredViewIds: string[] = []): StarrableView[] {
  const starred = new Set(starredViewIds)
  return views
    .map((view) => ({ ...view, starred: starred.has(view.id) }))
    .sort((a, b) => {
      if (a.starred !== b.starred) return a.starred ? -1 : 1
      return a.name.localeCompare(b.name)
    })
}

/** Toggle a view's star, returning the next starred-id list. */
export function toggleStarredView(starredViewIds: string[] = [], viewId: string): string[] {
  return starredViewIds.includes(viewId)
    ? starredViewIds.filter((id) => id !== viewId)
    : [...starredViewIds, viewId]
}

/**
 * Scope the board to the active view. With no view selected every issue shows;
 * with one selected only issues stamped with that view id during import (plus
 * issues created in Orchestra while it was active) survive.
 */
export function filterIssuesByView<T extends { linearViewIds?: string[] }>(
  issues: T[],
  activeViewId: string | undefined,
): T[] {
  if (!activeViewId) return issues
  return issues.filter((issue) => issue.linearViewIds?.includes(activeViewId))
}
