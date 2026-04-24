export type AgentProvider = 'claude' | 'codex'

export type KeyName = 'enter' | 'tab' | 'shift-tab' | 'escape' | 'up' | 'down'

export type SendStep =
  | { kind: 'text'; value: string }
  | { kind: 'key'; value: KeyName }
  | { kind: 'wait'; ms: number }

export interface ControlEntry {
  id: string
  label: string
  send: SendStep[]
}

export interface Control {
  id: string
  label: string
  icon?: string
  entries: ControlEntry[]
}

export type AgentControlsConfig = Record<AgentProvider, Control[]>

export type ResolvedStep =
  | { kind: 'write'; data: string }
  | { kind: 'wait'; ms: number }

const KEY_BYTES: Record<KeyName, string> = {
  'enter': '\r',
  'tab': '\t',
  'shift-tab': '\x1b[Z',
  'escape': '\x1b',
  'up': '\x1b[A',
  'down': '\x1b[B',
}

export function resolveSendSteps(steps: SendStep[]): ResolvedStep[] {
  return steps.map((step) => {
    if (step.kind === 'wait') return { kind: 'wait', ms: step.ms }
    if (step.kind === 'key') return { kind: 'write', data: KEY_BYTES[step.value] }
    return { kind: 'write', data: step.value }
  })
}

const TOKEN_RE = /\{\{([a-z-]+)(?::(\d+))?\}\}/g
const KNOWN_KEYS: ReadonlySet<KeyName> = new Set<KeyName>(['enter', 'tab', 'shift-tab', 'escape', 'up', 'down'])

export function parseSendExpression(input: string): SendStep[] {
  if (input === '') return []
  const steps: SendStep[] = []
  let cursor = 0
  for (const match of input.matchAll(TOKEN_RE)) {
    const [full, name, arg] = match
    const start = match.index
    const kind = recognizeToken(name, arg)
    if (kind === null) {
      // Unknown token — leave in place as literal text (continue scanning after it)
      continue
    }
    if (start > cursor) {
      steps.push({ kind: 'text', value: input.slice(cursor, start) })
    }
    steps.push(kind)
    cursor = start + full.length
  }
  if (cursor < input.length) {
    steps.push({ kind: 'text', value: input.slice(cursor) })
  }
  return steps
}

function recognizeToken(name: string, arg: string | undefined): SendStep | null {
  if (name === 'wait' && arg !== undefined) {
    const ms = Number.parseInt(arg, 10)
    if (Number.isFinite(ms) && ms >= 0) return { kind: 'wait', ms }
    return null
  }
  if (KNOWN_KEYS.has(name as KeyName)) {
    return { kind: 'key', value: name as KeyName }
  }
  return null
}

export function mergeControls(defaults: Control[], override: Control[] | undefined): Control[] {
  return override === undefined ? defaults : override
}

export const DEFAULT_AGENT_CONTROLS: AgentControlsConfig = {
  claude: [
    {
      id: 'claude.permission',
      label: 'Permission',
      entries: [
        {
          id: 'claude.perm.cycle',
          label: 'Cycle mode (Shift+Tab)',
          send: [{ kind: 'key', value: 'shift-tab' }],
        },
      ],
    },
    {
      id: 'claude.model',
      label: 'Model',
      entries: [
        {
          id: 'claude.model.open',
          label: 'Open model picker',
          send: [
            { kind: 'text', value: '/model' },
            { kind: 'key', value: 'enter' },
          ],
        },
      ],
    },
  ],
  codex: [
    {
      id: 'codex.model',
      label: 'Model',
      entries: [
        {
          id: 'codex.model.open',
          label: 'Open model picker',
          send: [
            { kind: 'text', value: '/model' },
            { kind: 'key', value: 'enter' },
          ],
        },
      ],
    },
    {
      id: 'codex.approvals',
      label: 'Approvals',
      entries: [
        {
          id: 'codex.approvals.open',
          label: 'Open approval picker',
          send: [
            { kind: 'text', value: '/approvals' },
            { kind: 'key', value: 'enter' },
          ],
        },
      ],
    },
  ],
}
