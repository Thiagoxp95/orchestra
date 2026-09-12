interface Disposable { dispose(): void }
interface TerminalDataSource { onData(listener: (data: string) => void): Disposable }
interface InputHandlers { user(data: string): void; response?(data: string): void }

/**
 * xterm 6 emits coreService.onUserInput synchronously before onData for real
 * keyboard, IME, mouse and paste input. Parser replies omit that signal. Bytes
 * cannot distinguish these origins: modified F3 and CPR can be identical.
 * Keep this single internal API seam covered by the real-xterm regression test.
 */
export function bindTerminalInput(terminal: TerminalDataSource, handlers: InputHandlers): () => void {
  const core = (terminal as TerminalDataSource & {
    _core?: { coreService?: { onUserInput?(listener: () => void): Disposable } }
  })._core?.coreService
  if (!core?.onUserInput) throw new Error('This xterm version does not expose user input provenance')
  let userInput = false
  const user = core.onUserInput(() => { userInput = true })
  const data = terminal.onData(value => {
    const wasUserInput = userInput
    userInput = false
    if (wasUserInput) handlers.user(value)
    else handlers.response?.(value)
  })
  return () => { user.dispose(); data.dispose(); userInput = false }
}
