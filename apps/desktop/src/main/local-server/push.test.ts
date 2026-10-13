import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendNotification = vi.fn()

vi.mock('web-push', () => ({
  default: {
    generateVAPIDKeys: () => ({ publicKey: 'pub', privateKey: 'priv' }),
    setVapidDetails: vi.fn(),
    sendNotification: (...args: unknown[]) => sendNotification(...args),
  },
}))
vi.mock('electron-store', () => ({
  default: class {
    private data: Record<string, unknown> = {}
    get(key: string) {
      return this.data[key]
    }
    set(key: string, value: unknown) {
      this.data[key] = value
    }
  },
}))

import { setDurableStore, Table, type DurableStore } from './durable-store'
import Store from 'electron-store'
import { resetPushKeys, savePushSubscription, sendPushNotification } from './push'

function freshStore(): DurableStore {
  const store = new Store<Record<string, unknown>>()
  return {
    issues: new Table(store, 'issues'),
    issueLabels: new Table(store, 'issueLabels'),
    webhooks: new Table(store, 'webhooks'),
    webhookEvents: new Table(store, 'webhookEvents'),
    pushSubscriptions: new Table(store, 'pushSubscriptions'),
  }
}

describe('sendPushNotification', () => {
  let store: DurableStore

  beforeEach(() => {
    sendNotification.mockReset()
    resetPushKeys()
    store = freshStore()
    setDurableStore(store)
  })

  it('reports each push service status, prunes 404/410, keeps the rest', async () => {
    savePushSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/live', p256dh: 'k', auth: 'a' })
    savePushSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/gone', p256dh: 'k', auth: 'a' })
    savePushSubscription({ endpoint: 'https://web.push.apple.com/flaky', p256dh: 'k', auth: 'a' })
    sendNotification.mockImplementation(async (sub: { endpoint: string }) => {
      if (sub.endpoint.endsWith('/gone')) throw Object.assign(new Error('Gone'), { statusCode: 410 })
      if (sub.endpoint.endsWith('/flaky')) throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
      return { statusCode: 201 }
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const results = await sendPushNotification({ title: 't', body: 'b' })

    expect(results.map((r) => [r.host, r.statusCode, r.pruned])).toEqual([
      ['fcm.googleapis.com', 201, false],
      ['fcm.googleapis.com', 410, true],
      ['web.push.apple.com', 403, false],
    ])
    const rows = store.pushSubscriptions.all()
    expect(rows.map((r) => r.endpoint)).toEqual([
      'https://fcm.googleapis.com/fcm/send/live',
      'https://web.push.apple.com/flaky',
    ])
    expect(rows[0].lastSuccessAt).toEqual(expect.any(Number))
    expect(rows[1].lastFailure?.statusCode).toBe(403)
  })

  it('returns nothing when no phone has subscribed', async () => {
    expect(await sendPushNotification({ title: 't', body: 'b' })).toEqual([])
    expect(sendNotification).not.toHaveBeenCalled()
  })
})
