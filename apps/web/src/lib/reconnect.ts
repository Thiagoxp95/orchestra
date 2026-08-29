/**
 * The manual half of staying connected: force the mirror link back up, now.
 *
 * The automatic halves already exist — useForegroundResync pokes Convex when the
 * page returns to the foreground, and the desktop bridge rebuilds its own client
 * when its pushes stop settling. Neither helps the case this covers: the PWA is
 * already in the foreground, the banner says the desktop is gone, and the user is
 * sitting there with no way to ask again. On a phone that roams between Wi-Fi,
 * cellular and Tailscale that is a routine state, and "close and reopen the app"
 * should not be the only remedy.
 *
 * Kept free of React and of the Convex client so the retry loop can be
 * unit-tested; the component injects the four things it touches.
 */

export type ReconnectOutcome =
  /** A fresh desktop push landed — the mirror is live again. */
  | 'live'
  /** The websocket never came up: this device still can't reach the mirror. */
  | 'no-socket'
  /** The socket is up, but the desktop stayed silent — it's the Mac, not us. */
  | 'desktop-silent'

export interface ReconnectDeps {
  /** Ask the Convex client to re-open its websocket immediately. */
  poke: () => void
  /** Convex's own view of its socket. */
  isConnected: () => boolean
  /** The mirror's newest `updatedAt`, read fresh on every poll. */
  updatedAt: () => number | null | undefined
  sleep: (ms: number) => Promise<void>
}

export interface ReconnectOptions {
  /** How long to wait for a fresh desktop push before returning a verdict. */
  timeoutMs?: number
  pollMs?: number
  /** Floor between two pokes, so a long wait can't become a reconnect storm. */
  pokeEveryMs?: number
}

/**
 * A push older than this is not evidence of life. Waiting only for a *newer*
 * `updatedAt` is the honest test — the desktop heartbeats every 10s, so one
 * arrives well inside the timeout whenever it is actually running.
 */
export async function attemptReconnect(
  deps: ReconnectDeps,
  { timeoutMs = 8_000, pollMs = 250, pokeEveryMs = 1_500 }: ReconnectOptions = {},
): Promise<ReconnectOutcome> {
  const before = deps.updatedAt() ?? null

  deps.poke()
  let sincePoke = 0
  let waited = 0
  // Seeded from the live socket rather than assumed false: when the socket was
  // fine all along, a silent desktop must not be misreported as our own fault.
  let sawSocket = deps.isConnected()

  while (waited < timeoutMs) {
    await deps.sleep(pollMs)
    waited += pollMs
    sincePoke += pollMs

    const connected = deps.isConnected()
    if (connected) {
      sawSocket = true
    } else if (sincePoke >= pokeEveryMs) {
      // Convex backs off between its own attempts; keep asking while we wait.
      deps.poke()
      sincePoke = 0
    }

    const at = deps.updatedAt() ?? null
    // `before == null` covers the never-mirrored case: any push at all is news.
    if (at != null && (before == null || at > before)) return 'live'
  }

  return sawSocket ? 'desktop-silent' : 'no-socket'
}

/** What to tell the user once the retry above has returned. */
export function describeReconnectOutcome(outcome: ReconnectOutcome): string {
  switch (outcome) {
    case 'live':
      return 'Reconnected.'
    case 'no-socket':
      return "Still offline — this device can't reach the mirror. Check Wi-Fi, cellular, or your VPN."
    case 'desktop-silent':
      return 'Connected, but your computer is still silent. Wake it, or reopen Orchestra there.'
  }
}
