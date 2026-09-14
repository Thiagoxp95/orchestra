// src/main/local-server/push.ts
//
// Web Push to the phone, sent straight from Electron. This used to be a Convex
// Node action reading VAPID keys out of deployment env vars.
//
// The keypair is now generated on first run and kept on this Mac, and the
// public half is handed to the browser at runtime. That removes the whole
// "generate keys, set three env vars, rebuild the web app" setup step — the
// only machine that needs the private key is the one doing the sending.

import Store from 'electron-store'
import webpush from 'web-push'
import { getDurableStore } from './durable-store'

export interface PushNotificationInput {
  title: string
  body: string
  sessionId?: string
  requiresUserInput?: boolean
}

export function buildPushPayload(input: PushNotificationInput): string {
  return JSON.stringify({
    title: input.title,
    body: input.body,
    sessionId: input.sessionId,
    requiresUserInput: input.requiresUserInput,
  })
}

/** 404/410 mean the browser threw the subscription away; stop retrying it. */
export function isExpiredPushError(statusCode: number): boolean {
  return statusCode === 404 || statusCode === 410
}

interface VapidKeys {
  publicKey: string
  privateKey: string
}

let keysStore: Store<Record<string, unknown>> | null = null
let cachedKeys: VapidKeys | null = null

/**
 * The tailnet has no stable mailto identity and push services only use the
 * subject for abuse contact, so a fixed placeholder is honest and keeps setup
 * at zero steps.
 */
const VAPID_SUBJECT = 'mailto:orchestra@localhost'

export function getVapidKeys(): VapidKeys {
  if (cachedKeys) return cachedKeys
  keysStore ??= new Store<Record<string, unknown>>({ name: 'push-keys' })
  const existing = keysStore.get('vapid') as VapidKeys | undefined
  if (existing?.publicKey && existing.privateKey) {
    cachedKeys = existing
    return existing
  }
  const generated = webpush.generateVAPIDKeys()
  const keys = { publicKey: generated.publicKey, privateKey: generated.privateKey }
  keysStore.set('vapid', keys)
  cachedKeys = keys
  return keys
}

/** Handed to the browser so it can call pushManager.subscribe. */
export function getVapidPublicKey(): string {
  return getVapidKeys().publicKey
}

export function savePushSubscription(sub: { endpoint: string; p256dh: string; auth: string }): void {
  const table = getDurableStore().pushSubscriptions
  const existing = table.find((row) => row.endpoint === sub.endpoint)
  if (existing) {
    table.patch(existing._id, { p256dh: sub.p256dh, auth: sub.auth })
    return
  }
  table.insert({ ...sub, createdAt: Date.now() })
}

export function removePushSubscription(endpoint: string): void {
  getDurableStore().pushSubscriptions.deleteWhere((row) => row.endpoint === endpoint)
}

/** Fan out to every subscribed phone, pruning the ones that have gone away. */
export async function sendPushNotification(input: PushNotificationInput): Promise<void> {
  const table = getDurableStore().pushSubscriptions
  const subscriptions = table.all()
  if (subscriptions.length === 0) return

  const keys = getVapidKeys()
  webpush.setVapidDetails(VAPID_SUBJECT, keys.publicKey, keys.privateKey)
  const payload = buildPushPayload(input)

  await Promise.all(
    subscriptions.map(async (row) => {
      try {
        await webpush.sendNotification(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          payload,
        )
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode
        if (typeof statusCode === 'number' && isExpiredPushError(statusCode)) {
          table.delete(row._id)
          return
        }
        console.error('[push] delivery failed', err)
      }
    }),
  )
}

/** Test seam. */
export function resetPushKeys(): void {
  cachedKeys = null
  keysStore = null
}
