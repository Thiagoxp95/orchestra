const PATTERN = /(?:^|[/\-])([a-zA-Z]{2,5})-(\d+)(?=$|[/\-])/

export function extractLinearIdentifier(branch: string): string | null {
  const match = PATTERN.exec(branch)
  if (!match) return null
  return `${match[1].toUpperCase()}-${match[2]}`
}
