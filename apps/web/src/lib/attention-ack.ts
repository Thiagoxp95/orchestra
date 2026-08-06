// "I've seen it": local acknowledgement of a session's needs-input signal.
//
// The desktop clears its yellow indicator the moment you focus the session
// (setActiveSession) — looking at the ask IS the acknowledgement. The phone
// couldn't do the same, because the signal it renders is mirrored, not owned:
// `liveStatus[id].attention` is recomputed on the desktop from the agent's
// normalized state, and a claude session parked at "waiting for user input"
// re-reports that state on every push. So opening the session, reading the
// question and pinching back out left the card still shouting for attention it
// had already got — the complaint this module answers.
//
// The rule is the desktop's, applied client-side: viewing a session while it is
// asking marks it acknowledged, and the mark holds until the situation actually
// changes — the desktop drops the signal itself, or the agent starts working
// again (whatever it asks after that turn is a NEW ask, which must light up).
//
// Deliberately not a mutation back to the desktop: the bridge's existing
// `attach` ack already clears the flag the desktop owns (sessionNeedsUserInput),
// and it is not the flag that survives — the normalized agent state is, and that
// one is a fact about the agent rather than a notification to be dismissed.
//
// Kept free of React so it can be unit-tested like the rest of src/lib.

export interface AckStatusLike {
  work?: 'idle' | 'working'
  attention?: 'input' | 'approval'
}

/**
 * The next acknowledged set, or null when nothing changed — the caller stores
 * state, so an unchanged answer must be identity-stable or it would re-render
 * on every mirror push.
 *
 * `viewing` is the session actually on screen right now (null when the overview
 * covers it, or when the page is in the background — an unread ask must not be
 * silenced by a phone sitting face-down on a session).
 */
export function nextAcknowledged(
  acked: ReadonlySet<string>,
  liveStatus: Record<string, AckStatusLike | undefined>,
  viewing: string | null,
): Set<string> | null {
  let next: Set<string> | null = null
  const edit = () => (next ??= new Set(acked))

  // Release the mark the moment its subject changes: the desktop stopped
  // reporting the ask (it was answered elsewhere), or the agent took another
  // turn — in which case anything it asks next is something we have NOT seen.
  for (const id of acked) {
    const status = liveStatus[id]
    if (!status?.attention || status.work === 'working') edit().delete(id)
  }

  // …and set it only for a session we're looking at *while it asks*. Viewing a
  // quiet session acknowledges nothing, so a question that arrives after you
  // leave still lights the card up.
  if (viewing && liveStatus[viewing]?.attention && !acked.has(viewing)) edit().add(viewing)

  return next
}

/**
 * The mirrored statuses with every acknowledged ask taken out, so a single call
 * up front makes the whole UI — cards, roll, sidebar counts — agree on what
 * still wants the user.
 */
export function applyAttentionAck<T extends AckStatusLike>(
  liveStatus: Record<string, T>,
  acked: ReadonlySet<string>,
): Record<string, T> {
  if (acked.size === 0) return liveStatus
  let out: Record<string, T> | null = null
  for (const id of acked) {
    const status = liveStatus[id]
    if (!status?.attention) continue
    out ??= { ...liveStatus }
    // Widening the spread back to T: dropping an optional field can't change
    // the shape, but TS won't infer that through the type parameter.
    out[id] = { ...status, attention: undefined } as T
  }
  return out ?? liveStatus
}
