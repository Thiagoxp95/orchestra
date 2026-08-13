// Mounts the chat pane over a session's terminal and feeds it the desktop's own
// state: the sidebar's working signal, the session's agent, and the context /
// model numbers the main process reads off the transcript. ChatPane itself is
// the ported web component and knows nothing about this store.

import { useEffect, useMemo, useState } from 'react'
import { MessageCircle, TerminalSquare } from 'lucide-react'
import { useAppStore } from '../store/app-store'
import { computeAgentView } from '../utils/agent-view-state'
import { ChatPane } from './ChatPane'
import type { AgentKind } from './lib/chat-messages'
import type { SlashCommand } from './lib/slash-commands'
import { cn } from './lib/utils'

/**
 * Which view the app is showing. Global rather than per-session, matching the
 * web: the choice is "how I read agents", not a property of one pane. A shell
 * session left in chat mode still gets the empty state's "Open terminal".
 */
const VIEW_MODE_KEY = 'orchestra.viewMode'

/** Chat unless the user has explicitly asked for the terminal — same default as
 *  the web, where reading the conversation is the normal way to follow an agent.
 *  Exported for the test that pins that default: shipping `terminal` here is what
 *  made a new agent session open on the grid. */
export function loadViewMode(): 'chat' | 'terminal' {
  try {
    return window.localStorage.getItem(VIEW_MODE_KEY) === 'terminal' ? 'terminal' : 'chat'
  } catch {
    return 'chat'
  }
}

/** Transcript-derived numbers refresh on the main process's own 1s poll; asking
 *  more often than that only burns IPC. */
const CONTEXT_POLL_MS = 2_000
/** Skills and commands are files a human edits by hand — a slow refresh is
 *  plenty, and the main-side catalog has its own 5-minute rescan floor anyway. */
const COMMANDS_POLL_MS = 60_000

/** The Chat ⌁ Term pill, floating over whichever view is up. */
export function ViewModeToggle({
  mode,
  onChange,
  ink,
}: {
  mode: 'chat' | 'terminal'
  onChange: (next: 'chat' | 'terminal') => void
  ink: string
}) {
  return (
    <div
      className="absolute left-1/2 top-2 z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-full border p-0.5 backdrop-blur-md"
      style={{ borderColor: `${ink}22`, backgroundColor: `${ink}0f` }}
    >
      {(
        [
          { key: 'chat' as const, label: 'Chat', Icon: MessageCircle },
          { key: 'terminal' as const, label: 'Term', Icon: TerminalSquare },
        ]
      ).map(({ key, label, Icon }) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          className={cn(
            'flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-opacity',
            mode === key ? 'opacity-100' : 'opacity-45 hover:opacity-75',
          )}
          style={{ color: ink, backgroundColor: mode === key ? `${ink}1a` : 'transparent' }}
        >
          <Icon className="size-3" />
          {label}
        </button>
      ))}
    </div>
  )
}

/** Read the persisted view mode and keep every mounted pane in step with it. */
export function useViewMode(): ['chat' | 'terminal', (next: 'chat' | 'terminal') => void] {
  const [mode, setMode] = useState<'chat' | 'terminal'>(loadViewMode)

  // One toggle, many mounted panes (every session in the workspace keeps its
  // terminal alive). A storage event fires only in OTHER documents, so the
  // sibling panes in this one are synced by the custom event below.
  useEffect(() => {
    const onChanged = () => setMode(loadViewMode())
    window.addEventListener('orchestra:viewmode', onChanged)
    return () => window.removeEventListener('orchestra:viewmode', onChanged)
  }, [])

  const change = (next: 'chat' | 'terminal') => {
    try {
      window.localStorage.setItem(VIEW_MODE_KEY, next)
    } catch {
      // Storage blocked — the choice just doesn't survive a restart.
    }
    window.dispatchEvent(new Event('orchestra:viewmode'))
  }

  return [mode, change]
}

export function SessionChat({
  sessionId,
  color,
  onShowTerminal,
}: {
  sessionId: string
  /** The workspace color the pane tints itself from. */
  color?: string
  onShowTerminal: () => void
}) {
  const session = useAppStore((s) => s.sessions[sessionId])
  const normalizedState = useAppStore((s) => s.normalizedAgentState[sessionId])
  const claudeWorkState = useAppStore((s) => s.claudeWorkState[sessionId])
  const codexWorkState = useAppStore((s) => s.codexWorkState[sessionId])
  const needsUserInput = useAppStore((s) => s.sessionNeedsUserInput[sessionId] === true)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)

  const [context, setContext] = useState<{
    usedTokens?: number
    contextWindow?: number
    model?: string
    effort?: string
  }>({})
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([])

  // The same working signal the sidebar renders from, so a shimmering row and
  // the chat's typing dots can never disagree.
  const working = useMemo(
    () =>
      computeAgentView({
        processStatus: session?.processStatus ?? 'terminal',
        normalizedState,
        claudeWorkState,
        codexWorkState,
        sessionNeedsUserInput: needsUserInput,
      }).isWorking,
    [session?.processStatus, normalizedState, claudeWorkState, codexWorkState, needsUserInput],
  )

  const agent: AgentKind | undefined =
    session?.processStatus === 'claude' || session?.processStatus === 'codex'
      ? session.processStatus
      : undefined

  // Context occupancy and the model/effort the session actually runs, both read
  // off the transcript by the main process. Polled rather than pushed: the
  // numbers move on the tracker's own second-scale clock, and a push channel for
  // them would be one more thing to keep alive for no visible gain.
  useEffect(() => {
    if (!agent) {
      setContext({})
      return
    }
    let cancelled = false
    const read = () => {
      void window.electronAPI
        .chatAgentContext()
        .then((all) => {
          if (cancelled) return
          setContext(all?.[sessionId] ?? {})
        })
        .catch(() => {})
    }
    read()
    const timer = setInterval(read, CONTEXT_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [sessionId, agent])

  // Per-agent: claude and codex read different directories and answer to
  // different command names, so the agent picks which catalog comes back. A
  // shell session gets none.
  useEffect(() => {
    if (!agent || !activeWorkspaceId) {
      setSlashCommands([])
      return
    }
    let cancelled = false
    const read = () => {
      void window.electronAPI
        .chatSlashCommands(activeWorkspaceId, agent)
        .then((rows) => {
          if (!cancelled) setSlashCommands(rows ?? [])
        })
        .catch(() => {})
    }
    read()
    const timer = setInterval(read, COMMANDS_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [agent, activeWorkspaceId])

  return (
    <ChatPane
      sessionId={sessionId}
      color={color}
      working={working}
      agent={agent}
      mirroredModel={context.model}
      mirroredEffort={context.effort}
      contextTokens={context.usedTokens}
      contextWindow={context.contextWindow}
      slashCommands={slashCommands}
      onShowTerminal={onShowTerminal}
    />
  )
}
