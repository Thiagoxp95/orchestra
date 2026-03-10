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
      shouldPrimeWorkState: true,
      shouldResetBinding: false,
    }
  }

  const cwdChanged = current.cwd !== next.cwd
  const pidChanged = next.codexPid != null && next.codexPid !== current.codexPid
  const shouldResetBinding = cwdChanged || pidChanged

  return {
    shouldPrimeWorkState: shouldResetBinding,
    shouldResetBinding,
  }
}
