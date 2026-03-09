export interface JsonlCandidate {
  path: string
  birthtime: number
  mtime: number
}

const JSONL_BIRTHTIME_TOLERANCE_MS = 2_000

export function rankJsonlCandidates(candidates: JsonlCandidate[], createdAt: number): JsonlCandidate[] {
  return [...candidates].sort((left, right) => {
    const leftWithinTolerance = left.birthtime >= createdAt - JSONL_BIRTHTIME_TOLERANCE_MS ? 0 : 1
    const rightWithinTolerance = right.birthtime >= createdAt - JSONL_BIRTHTIME_TOLERANCE_MS ? 0 : 1
    if (leftWithinTolerance !== rightWithinTolerance) {
      return leftWithinTolerance - rightWithinTolerance
    }

    const leftDistance = Math.abs(left.birthtime - createdAt)
    const rightDistance = Math.abs(right.birthtime - createdAt)
    if (leftDistance !== rightDistance) {
      return leftDistance - rightDistance
    }

    return right.mtime - left.mtime
  })
}

export function pickBestJsonlPath(candidates: JsonlCandidate[], createdAt: number): string | null {
  return rankJsonlCandidates(candidates, createdAt)[0]?.path ?? null
}

export function pickAssignableJsonlPath(
  candidates: JsonlCandidate[],
  createdAt: number,
  assignments: ReadonlyMap<string, string | null>,
  sessionId: string
): string | null {
  for (const candidate of rankJsonlCandidates(candidates, createdAt)) {
    const owner = assignments.get(candidate.path)
    if (!owner || owner === sessionId) {
      return candidate.path
    }
  }

  return null
}
