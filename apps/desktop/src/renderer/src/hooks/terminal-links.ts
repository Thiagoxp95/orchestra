import type { ILinkHandler } from '@xterm/xterm'

/**
 * OSC 8 hyperlinks (what Claude Code prints) go straight to the default browser.
 * xterm's built-in handler opens a blank window and then sets its location, so the
 * main process only ever saw `about:blank` and macOS had no app for it.
 */
export const terminalLinkHandler: ILinkHandler = {
  activate: (_event, uri) => { void window.electronAPI.openExternalUrl(uri) },
}
