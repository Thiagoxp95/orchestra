export interface CodexWatchRegistrationState {
  sessionId?: string
  cwd: string
  codexPid?: number
}

export interface CodexWatchRegistrationDecision {
  shouldPrimeWorkState: boolean
  shouldResetBinding: boolean
}

function hasSiblingSessionInSameCwd(
  current: Pick<CodexWatchRegistrationState, 'sessionId' | 'cwd'>,
  watchedSessions: ReadonlyArray<Pick<CodexWatchRegistrationState, 'sessionId' | 'cwd'>>
): boolean {
  for (const session of watchedSessions) {
    if (!session.sessionId || session.sessionId === current.sessionId) continue
    if (session.cwd === current.cwd) {
      return true
    }
  }

  return false
}

export function getCodexWatchRegistrationDecision(
  current: CodexWatchRegistrationState | null,
  next: CodexWatchRegistrationState
): CodexWatchRegistrationDecision {
  if (!current) {
    return {
      // Wait for rollout/thread evidence before showing the spinner.
      shouldPrimeWorkState: false,
      shouldResetBinding: false,
    }
  }

  const cwdChanged = current.cwd !== next.cwd
  const pidChanged = next.codexPid != null && next.codexPid !== current.codexPid
  const shouldResetBinding = cwdChanged || pidChanged

  return {
    // Binding can change eagerly, but the UI should only flip to working on real activity.
    shouldPrimeWorkState: false,
    shouldResetBinding,
  }
}

export function shouldAllowHeuristicCodexThreadBinding(
  current: Pick<CodexWatchRegistrationState, 'sessionId' | 'cwd'>,
  watchedSessions: ReadonlyArray<Pick<CodexWatchRegistrationState, 'sessionId' | 'cwd'>>
): boolean {
  return !hasSiblingSessionInSameCwd(current, watchedSessions)
}

export function shouldAllowPromptlessCodexRolloutBinding(
  current: Pick<CodexWatchRegistrationState, 'sessionId' | 'cwd'>,
  watchedSessions: ReadonlyArray<Pick<CodexWatchRegistrationState, 'sessionId' | 'cwd'>>
): boolean {
  return !hasSiblingSessionInSameCwd(current, watchedSessions)
}
