export interface CodexWatchRegistrationState {
  cwd: string
  codexPid?: number
}

export interface CodexWatchRegistrationDecision {
  shouldPrimeWorkState: boolean
  shouldResetBinding: boolean
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
