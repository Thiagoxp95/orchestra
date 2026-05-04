import { extractLinearIdentifier } from './linear-branch'

export function getWorktreeDisplayLabel(branch: string, displayName?: string): string {
  const alias = displayName?.trim()
  if (!alias) return branch

  const identifier = extractLinearIdentifier(branch)
  return identifier ? `${identifier} · ${alias}` : alias
}
