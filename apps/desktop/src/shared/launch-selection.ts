/**
 * The model / reasoning effort a session was LAUNCHED with, read off its own
 * initial command.
 *
 * The transcript is the only source that knows what an agent is *currently*
 * running, and it stays silent until the agent's first turn — so every freshly
 * spawned session reported no model and no effort, and both model pickers (the
 * phone's, via liveStatus, and the desktop's, via the context IPC) showed two
 * blank pills ("Model" / "Effort", nothing selected) on exactly the sessions a
 * user is most likely to be about to type into.
 *
 * The launch command carries the answer: the desktop pins `--model` /
 * `--effort` into every claude command (CLAUDE_DEFAULT_MODEL /
 * CLAUDE_DEFAULT_EFFORT in ./action-utils, or an action's own choice) and
 * codex's effort rides `-c model_reasoning_effort=`. Those flags ARE what the
 * session is running until something switches it, and a switch is what the
 * transcript reports — so this is a strictly pre-first-turn fallback, never an
 * override.
 *
 * Values are returned raw (`opus`, `high`).
 *
 * Shared because main (remote-bridge-livestatus) and the renderer both need it
 * and neither may import the other.
 */
export function parseLaunchSelection(initialCommand?: string): {
  model?: string
  effort?: string
} {
  if (!initialCommand) return {}
  const unquote = (v: string): string => v.replace(/^['"]|['"]$/g, '').trim()
  const flag = (names: string[]): string | undefined => {
    for (const name of names) {
      // `--model opus`, `--model=opus`, `-m gpt-5.5` — quoted or not.
      const m = initialCommand.match(
        new RegExp(`(?:^|\\s)${name}(?:=|\\s+)(['"]?)([^'"\\s]+)\\1`),
      )
      if (m) return unquote(m[2])
    }
    return undefined
  }
  const model = flag(['--model', '-m'])
  // codex takes no --effort; it is a `-c model_reasoning_effort="high"` override.
  const effort = flag(['--effort']) ?? flag(['model_reasoning_effort'])
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  }
}
