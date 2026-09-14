// Webhook listener — runs a workspace action when an inbound webhook fires.
//
// Events arrive at the app's own local server (POST /webhook/<token>, see
// local-server/webhook-intake.ts), are recorded in the durable store, and the
// server hands each new one here the moment it is queued. No subscription, no
// polling: the sender, the store and the runner are all this process.
//
//  Linear POST ──▶ local server ──▶ stores event ──callback──▶ here
//                                                              │
//                                                        ├─ stale check (60s)
//                                                        ├─ debounce (30s)
//                                                        ├─ atomic claim
//                                                        ├─ resolve local action
//                                                        └─ trigger in renderer
//
// If the app is not running when a webhook fires, the sender gets a connection
// error — there is no queue to fall behind on, and nothing to miss silently.

import { BrowserWindow, Notification } from 'electron'
import { getDurableStore, type WebhookEventRow } from './local-server/durable-store'
import { claimWebhookEvent, completeWebhookEvent, pendingWebhookEvents } from './local-server/webhook-intake'
import { loadPersistedData } from './persistence'
import { MOBILE_WEB_PORT, LOCAL_WEB_PORT } from './mobile-access'
import { readTailnetHost } from './running-servers'

const ACTION_DEBOUNCE_MS = 30_000 // Ignore duplicate triggers within 30s
const STALE_EVENT_MS = 60_000 // Skip events older than 60s (queued while the runner was down)

let mainWindow: BrowserWindow | null = null
let running = false

/** Tracks when each action was last triggered to debounce rapid-fire webhooks. */
const lastTriggeredAt = new Map<string, number>()

/** Prevents double-processing when an event is delivered while mid-claim. */
const processingEvents = new Set<string>()

// ── Public API ───────────────────────────────────────────────────────

/**
 * The URL a sender posts to. It is the app's Tailscale Serve address, so only
 * a sender on the tailnet can reach it — a cloud service (Linear's own
 * webhooks) needs the user to front this with something like Tailscale Funnel.
 * Falls back to the loopback address when Tailscale is not running, which is
 * at least correct for a local test.
 */
async function webhookUrl(token: string): Promise<string> {
  const host = await readTailnetHost().catch(() => undefined)
  const origin = host ? `https://${host}:${MOBILE_WEB_PORT}` : `http://127.0.0.1:${LOCAL_WEB_PORT}`
  return `${origin}/webhook/${token}`
}

export async function createWebhook(
  workspaceId: string,
  actionId: string,
  actionName: string,
  filter?: string,
): Promise<{ token: string; url: string }> {
  const token = crypto.randomUUID()
  getDurableStore().webhooks.insert({
    token,
    workspaceId,
    actionId,
    name: actionName,
    filter: filter || undefined,
    enabled: true,
    createdAt: Date.now(),
  })
  return { token, url: await webhookUrl(token) }
}

export async function deleteWebhook(token: string): Promise<void> {
  getDurableStore().webhooks.deleteWhere((row) => row.token === token)
}

export async function updateWebhookFilter(token: string, filter?: string): Promise<void> {
  const table = getDurableStore().webhooks
  const row = table.find((w) => w.token === token)
  if (row) table.patch(row._id, { filter: filter || undefined })
}

// ── Lifecycle ─────────────────────────────────────────────────────────

export function startWebhookListener(win?: BrowserWindow): void {
  if (win) mainWindow = win
  if (running) return
  running = true
  if (!hasAnyWebhooks()) {
    console.log('[webhook-listener] No webhooks configured')
    return
  }
  // Anything queued by a previous run. The stale check inside expires what is
  // too old to still be worth running.
  for (const event of pendingWebhookEvents()) handleWebhookEvent(event)
}

export function stopWebhookListener(): void {
  running = false
  processingEvents.clear()
  console.log('[webhook-listener] Stopped')
}

/** Called when a webhook is enabled. */
export function ensureWebhookListenerRunning(): void {
  if (!running) startWebhookListener()
}

/** Call after disabling a webhook. Kept for symmetry with the enable path. */
export function refreshWebhookListener(): void {
  ensureWebhookListenerRunning()
}

/** The local server's delivery hook: one event, the moment it is queued. */
export function handleWebhookEvent(event: WebhookEventRow): void {
  if (!running) return
  if (processingEvents.has(event._id)) return
  processingEvents.add(event._id)
  void processEvent(event, Date.now())
    .catch((err) => console.error('[webhook-listener] event failed', event._id, err))
    .finally(() => processingEvents.delete(event._id))
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

async function processEvent(event: WebhookEventRow, now: number): Promise<void> {
  // Skip stale events — queued while the runner was down.
  if (now - event.createdAt > STALE_EVENT_MS) {
    console.log(`[webhook-listener] Stale event ${event._id} (age: ${Math.round((now - event.createdAt) / 1000)}s), skipping`)
    completeWebhookEvent(event._id, 'expired')
    return
  }

  // Atomic claim — only one runner processes this event.
  if (!claimWebhookEvent(event._id)) return

  // Resolve local action
  const data = loadPersistedData()
  const workspace = data.workspaces[event.workspaceId]
  if (!workspace) {
    console.warn(`[webhook-listener] Workspace ${event.workspaceId} not found`)
    completeWebhookEvent(event._id, 'failed')
    return
  }

  const action = workspace.customActions.find((a) => a.id === event.actionId)
  if (!action) {
    console.warn(`[webhook-listener] Action ${event.actionId} not found in workspace ${workspace.name}`)
    completeWebhookEvent(event._id, 'failed')
    return
  }

  // Debounce — Linear fires multiple webhooks for a single user action
  const lastTrigger = lastTriggeredAt.get(event.actionId)
  if (lastTrigger && now - lastTrigger < ACTION_DEBOUNCE_MS) {
    console.log(`[webhook-listener] Debounced "${action.name}" (${Math.round((now - lastTrigger) / 1000)}s since last trigger)`)
    completeWebhookEvent(event._id, 'completed')
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

  completeWebhookEvent(event._id, 'completed')
}
