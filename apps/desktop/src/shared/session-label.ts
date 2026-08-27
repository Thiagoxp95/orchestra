import type { TerminalSession } from './types'

/**
 * What to call a session on screen.
 *
 * `label` auto-tracks the last prompt sent to the agent, which is the right
 * default and the wrong thing the moment someone deliberately names a session —
 * so a user-typed `customLabel` wins permanently, and clearing it hands the name
 * back to the auto label. Every surface that shows a session name (desktop
 * sidebar, maestro pane, the web/phone mirror) goes through this.
 */
export function sessionDisplayLabel(
  session: Pick<TerminalSession, 'label'> & { customLabel?: string },
): string {
  const custom = session.customLabel?.trim()
  return custom || session.label
}
