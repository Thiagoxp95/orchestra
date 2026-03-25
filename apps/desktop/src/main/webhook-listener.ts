// Webhook listener — real-time Convex subscription for webhook events.
//
// Uses Convex's WebSocket sync to react instantly when events arrive.
// No polling. If the app is offline when a webhook fires, it's missed.
//
//  Linear POST ──▶ Convex HTTP ──▶ stores event ──WebSocket──▶ desktop
//                                                                │
//                                                          ├─ stale check (60s)
//                                                          ├─ debounce (30s)
//                                                          ├─ atomic claim
//                                                          ├─ resolve local action
//                                                          └─ trigger in renderer

import { BrowserWindow, Notification } from 'electron'
import { ConvexClient } from 'convex/browser'
import { anyApi } from 'convex/server'
import { CONVEX_CLOUD_URL, CONVEX_SITE_URL } from './convex-config'
import { loadPersistedData } from './persistence'

const ACTION_DEBOUNCE_MS = 30_000 // Ignore duplicate triggers within 30s
const STALE_EVENT_MS = 60_000 // Skip events older than 60s (missed while offline)

let client: ConvexClient | null = null
let unsubscribePending: (() => void) | null = null
let mainWindow: BrowserWindow | null = null

/** Tracks when each action was last triggered to debounce rapid-fire webhooks. */
const lastTriggeredAt = new Map<string, number>()

/** Prevents double-processing when the subscription fires while an event is mid-claim. */
const processingEvents = new Set<string>()

// ── Convex client ─────────────────────────────────────────────────────

function getClient(): ConvexClient {
  if (!client) {
    client = new ConvexClient(CONVEX_CLOUD_URL)
  }
  return client
}

// ── Public API ───────────────────────────────────────────────────────

export async function createWebhook(
  workspaceId: string,
  actionId: string,
  actionName: string,
  filter?: string,
): Promise<{ token: string; url: string }> {
  const token = crypto.randomUUID()
  await getClient().mutation(anyApi.webhooks.create, {
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
  await getClient().mutation(anyApi.webhooks.remove, { token })
}

export async function updateWebhookFilter(token: string, filter?: string): Promise<void> {
  await getClient().mutation(anyApi.webhooks.updateFilter, { token, filter: filter || undefined })
}

// ── Lifecycle ─────────────────────────────────────────────────────────

export function startWebhookListener(win?: BrowserWindow): void {
  if (win) mainWindow = win
  if (unsubscribePending) return

  if (!hasAnyWebhooks()) {
    console.log('[webhook-listener] No webhooks configured, skipping start')
    return
  }

  subscribe()
}

export function stopWebhookListener(): void {
  if (unsubscribePending) {
    unsubscribePending()
    unsubscribePending = null
  }
  if (client) {
    void client.close()
    client = null
  }
  processingEvents.clear()
  console.log('[webhook-listener] Stopped')
}

/** Force-start the listener. Called when a webhook is enabled. */
export function ensureWebhookListenerRunning(): void {
  if (!unsubscribePending) subscribe()
}

/** Call after disabling a webhook to stop the listener if no webhooks remain. */
export function refreshWebhookListener(): void {
  if (hasAnyWebhooks()) {
    ensureWebhookListenerRunning()
  } else {
    stopWebhookListener()
  }
}

// ── Internals ─────────────────────────────────────────────────────────

function hasAnyWebhooks(): boolean {
  const data = loadPersistedData()
  for (const ws of Object.values(data.workspaces)) {
    for (const action of ws.customActions) {
      if (action.webhookToken) return true
    }
  }
  return false
}

function subscribe(): void {
  const c = getClient()

  console.log('[webhook-listener] Subscribing (real-time)')

  unsubscribePending = c.onUpdate(
    anyApi.webhooks.getPendingEvents,
    {},
    (events: PendingEvent[] | null) => {
      if (!events || events.length === 0) return
      const now = Date.now()
      for (const event of events) {
        if (processingEvents.has(event._id)) continue
        processingEvents.add(event._id)
        void processEvent(event, now).finally(() => {
          processingEvents.delete(event._id)
        })
      }
    },
  )
}

interface PendingEvent {
  _id: string
  token: string
  workspaceId: string
  actionId: string
  payload: unknown
  status: string
  createdAt: number
}

async function processEvent(event: PendingEvent, now: number): Promise<void> {
  const c = getClient()

  // Skip stale events — arrived while we were offline
  if (now - event.createdAt > STALE_EVENT_MS) {
    console.log(`[webhook-listener] Stale event ${event._id} (age: ${Math.round((now - event.createdAt) / 1000)}s), skipping`)
    await c.mutation(anyApi.webhooks.completeEvent, {
      eventId: event._id,
      status: 'expired',
    })
    return
  }

  // Atomic claim — only one client processes this event
  const claimed = await c.mutation(anyApi.webhooks.claimEvent, { eventId: event._id })
  if (!claimed) return

  // Resolve local action
  const data = loadPersistedData()
  const workspace = data.workspaces[event.workspaceId]
  if (!workspace) {
    console.warn(`[webhook-listener] Workspace ${event.workspaceId} not found`)
    await c.mutation(anyApi.webhooks.completeEvent, {
      eventId: event._id,
      status: 'failed',
    })
    return
  }

  const action = workspace.customActions.find((a) => a.id === event.actionId)
  if (!action) {
    console.warn(`[webhook-listener] Action ${event.actionId} not found in workspace ${workspace.name}`)
    await c.mutation(anyApi.webhooks.completeEvent, {
      eventId: event._id,
      status: 'failed',
    })
    return
  }

  // Debounce — Linear fires multiple webhooks for a single user action
  const lastTrigger = lastTriggeredAt.get(event.actionId)
  if (lastTrigger && now - lastTrigger < ACTION_DEBOUNCE_MS) {
    console.log(`[webhook-listener] Debounced "${action.name}" (${Math.round((now - lastTrigger) / 1000)}s since last trigger)`)
    await c.mutation(anyApi.webhooks.completeEvent, {
      eventId: event._id,
      status: 'completed',
    })
    return
  }

  lastTriggeredAt.set(event.actionId, now)

  console.log(`[webhook-listener] Triggering "${action.name}" in "${workspace.name}"`)

  new Notification({
    title: `Webhook: ${action.name}`,
    body: `Triggered in ${workspace.name}`,
  }).show()

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('webhook-run-action', {
      workspaceId: event.workspaceId,
      actionId: event.actionId,
    })

    // Dev-only toast notification
    if (process.env.NODE_ENV !== 'production') {
      mainWindow.webContents.send('webhook-event-notification', {
        actionName: action.name,
        workspaceName: workspace.name,
        workspaceColor: workspace.color ?? '#2a2a3e',
        status: 'pending',
        payload: event.payload,
        filterPassed: true,
        createdAt: event.createdAt,
      })
    }
  }

  await c.mutation(anyApi.webhooks.completeEvent, {
    eventId: event._id,
    status: 'completed',
  })
}
