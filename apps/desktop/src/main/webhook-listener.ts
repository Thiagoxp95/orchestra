// Webhook listener — polls Convex for pending webhook events and triggers
// the associated local action via the automation scheduler.
//
//  Convex (pending events) ──poll 5s──▶ webhook-listener
//       │                                    │
//       │                              ├─ TTL check (1h)
//       │                              ├─ atomic claim
//       │                              ├─ resolve local action
//       │                              ├─ executeAutomation()
//       │                              └─ mark completed/failed
//       │
//       ◀── claimEvent / completeEvent ──────┘
//

import { BrowserWindow, Notification } from 'electron'
import { CONVEX_CLOUD_URL, CONVEX_SITE_URL } from './convex-config'
import { loadPersistedData } from './persistence'

const POLL_INTERVAL_MS = 5_000
const EVENT_TTL_MS = 60 * 60 * 1000 // 1 hour
const REQUEST_TIMEOUT_MS = 10_000

let pollTimer: ReturnType<typeof setInterval> | null = null
let isPolling = false
let mainWindow: BrowserWindow | null = null
let lastNotifiedAt: number = Date.now()

// ── Convex API helpers ───────────────────────────────────────────────

async function convexQuery(functionPath: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const signal = typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    : undefined
  const response = await fetch(`${CONVEX_CLOUD_URL}/api/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: functionPath, args, format: 'json' }),
    signal,
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Convex query ${functionPath} failed: ${response.status} ${text}`)
  }
  const result = await response.json()
  return result.value
}

async function convexMutation(functionPath: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const signal = typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    : undefined
  const response = await fetch(`${CONVEX_CLOUD_URL}/api/mutation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: functionPath, args, format: 'json' }),
    signal,
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Convex mutation ${functionPath} failed: ${response.status} ${text}`)
  }
  const result = await response.json()
  return result.value
}

// ── Public API ───────────────────────────────────────────────────────

export async function createWebhook(
  workspaceId: string,
  actionId: string,
  actionName: string,
  filter?: string,
): Promise<{ token: string; url: string }> {
  const token = crypto.randomUUID()
  await convexMutation('webhooks:create', {
    token,
    workspaceId,
    actionId,
    name: actionName,
    filter: filter || undefined,
  })
  const url = `${CONVEX_SITE_URL}/webhook/${token}`
  return { token, url }
}

export async function deleteWebhook(token: string): Promise<void> {
  await convexMutation('webhooks:remove', { token })
}

export async function updateWebhookFilter(token: string, filter?: string): Promise<void> {
  await convexMutation('webhooks:updateFilter', { token, filter: filter || undefined })
}

// ── Polling loop ─────────────────────────────────────────────────────

export function startWebhookListener(win?: BrowserWindow): void {
  if (win) mainWindow = win
  if (pollTimer) return

  // Only start if at least one action has a webhook enabled
  if (!hasAnyWebhooks()) {
    console.log('[webhook-listener] No webhooks configured, skipping start')
    return
  }

  console.log('[webhook-listener] Starting (poll every %dms)', POLL_INTERVAL_MS)
  pollTimer = setInterval(pollAndProcess, POLL_INTERVAL_MS)
  // Run immediately on start
  pollAndProcess()
}

export function stopWebhookListener(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
    console.log('[webhook-listener] Stopped')
  }
}

/** Force-start the listener. Called when a webhook is enabled. */
export function ensureWebhookListenerRunning(): void {
  if (!pollTimer) {
    console.log('[webhook-listener] Starting (poll every %dms)', POLL_INTERVAL_MS)
    pollTimer = setInterval(pollAndProcess, POLL_INTERVAL_MS)
    pollAndProcess()
  }
}

/** Call after disabling a webhook to stop the listener if no webhooks remain. */
export function refreshWebhookListener(): void {
  if (hasAnyWebhooks()) {
    if (!pollTimer) startWebhookListener()
  } else {
    stopWebhookListener()
  }
}

function hasAnyWebhooks(): boolean {
  const data = loadPersistedData()
  for (const ws of Object.values(data.workspaces)) {
    for (const action of ws.customActions) {
      if (action.webhookToken) return true
    }
  }
  return false
}

// ── Event processing ─────────────────────────────────────────────────

interface PendingEvent {
  _id: string
  token: string
  workspaceId: string
  actionId: string
  payload: unknown
  status: string
  createdAt: number
}

interface WebhookEventNotification {
  _id: string
  token: string
  workspaceId: string
  actionId: string
  payload: unknown
  status: string
  filterPrompt?: string
  filterResult?: string
  createdAt: number
}

function sendWebhookNotification(event: WebhookEventNotification): void {
  if (!mainWindow || mainWindow.isDestroyed()) return

  const data = loadPersistedData()
  const workspace = data.workspaces[event.workspaceId]
  const action = workspace?.customActions.find((a) => a.id === event.actionId)

  mainWindow.webContents.send('webhook-event-notification', {
    actionName: action?.name ?? 'Unknown Action',
    workspaceName: workspace?.name ?? 'Unknown',
    workspaceColor: workspace?.color ?? '#2a2a3e',
    status: event.status as 'pending' | 'filtered',
    payload: event.payload,
    filterPrompt: event.filterPrompt,
    filterResult: event.filterResult,
    filterPassed: event.status !== 'filtered',
    createdAt: event.createdAt,
  })
}

async function pollAndProcess(): Promise<void> {
  if (isPolling) return
  isPolling = true

  try {
    const events = (await convexQuery('webhooks:getPendingEvents')) as PendingEvent[] | null

    if (events && events.length > 0) {
      const now = Date.now()

      for (const event of events) {
        try {
          await processEvent(event, now)
        } catch (error) {
          console.error(`[webhook-listener] Failed to process event ${event._id}:`, error)
          try {
            await convexMutation('webhooks:completeEvent', {
              eventId: event._id,
              status: 'failed',
            })
          } catch {
            // Best-effort status update
          }
        }
      }
    }

    // Dev-only: fetch recent events (all statuses) for toast notifications
    if (process.env.NODE_ENV !== 'production') {
      try {
        const recentEvents = (await convexQuery('webhooks:getRecentEventNotifications', {
          since: lastNotifiedAt,
        })) as WebhookEventNotification[] | null

        if (recentEvents && recentEvents.length > 0) {
          lastNotifiedAt = Math.max(...recentEvents.map((e) => e.createdAt))
          for (const event of recentEvents) {
            sendWebhookNotification(event)
          }
        }
      } catch (error) {
        console.error('[webhook-listener] Notification query failed:', error)
      }
    }
  } catch (error) {
    // Silently ignore poll failures (network issues, Convex downtime)
    console.error('[webhook-listener] Poll failed:', error)
  } finally {
    isPolling = false
  }
}

async function processEvent(event: PendingEvent, now: number): Promise<void> {
  // TTL check — skip events older than 1 hour
  if (now - event.createdAt > EVENT_TTL_MS) {
    console.log(`[webhook-listener] Expiring old event ${event._id} (age: ${Math.round((now - event.createdAt) / 1000)}s)`)
    await convexMutation('webhooks:completeEvent', {
      eventId: event._id,
      status: 'expired',
    })
    return
  }

  // Atomic claim — only one instance processes this event
  const claimed = await convexMutation('webhooks:claimEvent', { eventId: event._id })
  if (!claimed) return

  // Resolve local action
  const data = loadPersistedData()
  const workspace = data.workspaces[event.workspaceId]
  if (!workspace) {
    console.warn(`[webhook-listener] Workspace ${event.workspaceId} not found for event ${event._id}`)
    await convexMutation('webhooks:completeEvent', {
      eventId: event._id,
      status: 'failed',
    })
    return
  }

  const action = workspace.customActions.find((a) => a.id === event.actionId)
  if (!action) {
    console.warn(`[webhook-listener] Action ${event.actionId} not found in workspace ${workspace.name}`)
    await convexMutation('webhooks:completeEvent', {
      eventId: event._id,
      status: 'failed',
    })
    return
  }

  // Tell the renderer to run the action as a visible session
  console.log(`[webhook-listener] Triggering action "${action.name}" in workspace "${workspace.name}"`)

  new Notification({
    title: `Webhook: ${action.name}`,
    body: `Triggered in ${workspace.name}`,
  }).show()

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('webhook-run-action', {
      workspaceId: event.workspaceId,
      actionId: event.actionId,
    })
  } else {
    console.warn('[webhook-listener] No main window — cannot trigger action visually')
  }

  await convexMutation('webhooks:completeEvent', {
    eventId: event._id,
    status: 'completed',
  })
}
