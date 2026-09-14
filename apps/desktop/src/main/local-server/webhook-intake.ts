// src/main/local-server/webhook-intake.ts
//
// The `POST /webhook/<token>` endpoint external services trigger actions
// through. Previously a Convex httpAction, which had a public URL; this now
// only answers on the tailnet, so a sender must be on it too. That is a real
// reduction in reach and it is called out in infra/tailscale/README.md.

import { getDurableStore, type WebhookEventRow } from './durable-store'
import { evaluateWebhookFilter } from './summarize'

export interface IntakeResult {
  status: number
  body: Record<string, unknown>
  /** Set when an event was queued, so the caller can kick the runner. */
  event?: WebhookEventRow
}

export function parseWebhookBody(raw: string): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return { raw }
  }
}

/**
 * Validate the token, apply the filter, and queue the event.
 *
 * A filtered event is still recorded, with the model's reason attached, so the
 * user can see why their webhook didn't fire instead of wondering.
 */
export async function receiveWebhook(token: string, raw: string): Promise<IntakeResult> {
  if (!token) return { status: 400, body: { error: 'Missing token' } }

  const store = getDurableStore()
  const webhook = store.webhooks.find((row) => row.token === token)
  if (!webhook) return { status: 404, body: { error: 'Webhook not found' } }
  if (!webhook.enabled) return { status: 403, body: { error: 'Webhook disabled' } }

  const payload = parseWebhookBody(raw)
  const common = {
    webhookId: webhook._id,
    token,
    workspaceId: webhook.workspaceId,
    actionId: webhook.actionId,
    payload,
    createdAt: Date.now(),
  }

  if (!webhook.filter) {
    const event = store.webhookEvents.insert({ ...common, status: 'pending' })
    return { status: 200, body: { ok: true }, event }
  }

  const verdict = await evaluateWebhookFilter(webhook.filter, payload)
  if (!verdict.pass) {
    store.webhookEvents.insert({
      ...common,
      status: 'filtered',
      filterPrompt: webhook.filter,
      filterResult: verdict.reason,
    })
    return { status: 200, body: { ok: false, filtered: true, reason: verdict.reason } }
  }

  const event = store.webhookEvents.insert({
    ...common,
    status: 'pending',
    filterPrompt: webhook.filter,
    filterResult: verdict.reason,
  })
  return { status: 200, body: { ok: true }, event }
}

/** Atomically claim a pending event. Null when another runner already has it. */
export function claimWebhookEvent(eventId: string): WebhookEventRow | null {
  const table = getDurableStore().webhookEvents
  const event = table.get(eventId)
  if (!event || event.status !== 'pending') return null
  return table.patch(eventId, { status: 'processing' })
}

export function completeWebhookEvent(eventId: string, status: 'completed' | 'failed' | 'expired'): void {
  const table = getDurableStore().webhookEvents
  if (!table.get(eventId)) return
  table.patch(eventId, { status, processedAt: Date.now() })
}

export function pendingWebhookEvents(): WebhookEventRow[] {
  return getDurableStore()
    .webhookEvents.filter((row) => row.status === 'pending')
    .slice(0, 50)
}

export function recentWebhookEvents(since: number): WebhookEventRow[] {
  return getDurableStore()
    .webhookEvents.filter((row) => row.createdAt > since)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 20)
}

const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** Replaces the `cleanupOldEvents` cron. */
export function reapWebhookEvents(now: number = Date.now()): number {
  return getDurableStore().webhookEvents.deleteWhere((row) => now - row.createdAt > EVENT_RETENTION_MS)
}
