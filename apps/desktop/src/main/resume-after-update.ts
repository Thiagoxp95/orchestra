// Restart & update brings agents back on their own.
//
// The PTY daemon outlives an app update by design (daemon-launcher defers its
// own upgrade), so usually every agent is still running when the new version
// opens and there is nothing to do. When one did die anyway — the daemon went
// down with the app, or an agent was killed on the way — the person clicked
// "Restart & update", not "close my sessions": those panes are resumed in place
// with no prompt. Only panes that were running an agent with a known
// conversation at the moment of the click are eligible, and only on the launch
// that follows it.

import * as fs from 'node:fs'
import { join } from 'node:path'
import { getOrchestraHomeDir } from './orchestra-paths'
import { isResumableAgent } from '../shared/action-utils'
import type { TerminalSession } from '../shared/types'

/** A marker older than this was not left by the restart we are coming back from. */
const MARKER_MAX_AGE_MS = 15 * 60_000

interface ResumeMarker {
  recordedAt: number
  sessionIds: string[]
}

function markerPath(homeDir?: string): string {
  return join(homeDir ?? getOrchestraHomeDir(), 'resume-after-update.json')
}

/** Panes running an agent whose conversation is known — the ones worth bringing back. */
export function agentSessionsToResume(
  sessions: Record<string, Pick<TerminalSession, 'processStatus' | 'resumeSessionId'>>,
): string[] {
  return Object.entries(sessions)
    .filter(([, s]) => !!s.resumeSessionId && isResumableAgent(s.processStatus))
    .map(([id]) => id)
}

export function recordSessionsForResume(sessionIds: string[], homeDir?: string, now: number = Date.now()): void {
  try {
    const marker: ResumeMarker = { recordedAt: now, sessionIds }
    fs.writeFileSync(markerPath(homeDir), JSON.stringify(marker))
  } catch {
    // Best-effort: without it the rows still offer Resume by hand.
  }
}

/**
 * Consume the marker (once — a later launch must not resume again) and return
 * the recorded panes that have no live PTY now.
 */
export function takeSessionsForResume(liveSessionIds: Set<string>, homeDir?: string, now: number = Date.now()): string[] {
  const file = markerPath(homeDir)
  let marker: ResumeMarker
  try {
    marker = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return []
  } finally {
    try { fs.rmSync(file, { force: true }) } catch {}
  }
  if (!Array.isArray(marker?.sessionIds) || !(now - marker.recordedAt < MARKER_MAX_AGE_MS)) return []
  return marker.sessionIds.filter((id) => typeof id === 'string' && !liveSessionIds.has(id))
}
