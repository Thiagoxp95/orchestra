// src/main/local-server/durable-store.ts
//
// The handful of tables that are real data rather than a mirror of desktop
// state: the issue board, its labels, the webhook registry, and phone push
// subscriptions. Everything else the phone reads is derived from live desktop
// state and is rebuilt on reconnect, so it never needs to be written down.
//
// Records keep Convex's `_id` / `_creationTime` field names. The issue board
// renderer already threads those through, and preserving them means this swap
// is invisible above the data layer.

import { randomUUID } from 'node:crypto'
import Store from 'electron-store'
import type { IssueStatus, IssueRow, IssueLabelRow } from '../../shared/issue-types'

export interface Row {
  _id: string
  _creationTime: number
}

export type New<T extends Row> = Omit<T, keyof Row>

/**
 * An array-backed table. Every table here is small — a few hundred issues at
 * the very most — so full scans cost less than maintaining indexes would.
 */
export class Table<T extends Row> {
  constructor(
    private readonly store: Store<Record<string, unknown>>,
    private readonly key: string,
  ) {}

  all(): T[] {
    return (this.store.get(this.key) as T[] | undefined) ?? []
  }

  private write(rows: T[]): void {
    this.store.set(this.key, rows)
  }

  find(predicate: (row: T) => boolean): T | null {
    return this.all().find(predicate) ?? null
  }

  filter(predicate: (row: T) => boolean): T[] {
    return this.all().filter(predicate)
  }

  get(id: string): T | null {
    return this.find((row) => row._id === id)
  }

  insert(value: New<T>): T {
    const row = { ...value, _id: randomUUID(), _creationTime: Date.now() } as T
    this.write([...this.all(), row])
    return row
  }

  patch(id: string, fields: Partial<New<T>>): T | null {
    const rows = this.all()
    const index = rows.findIndex((row) => row._id === id)
    if (index === -1) return null
    const next = { ...rows[index], ...fields }
    rows[index] = next
    this.write(rows)
    return next
  }

  delete(id: string): boolean {
    const rows = this.all()
    const next = rows.filter((row) => row._id !== id)
    if (next.length === rows.length) return false
    this.write(next)
    return true
  }

  deleteWhere(predicate: (row: T) => boolean): number {
    const rows = this.all()
    const next = rows.filter((row) => !predicate(row))
    this.write(next)
    return rows.length - next.length
  }
}

// Issue rows live in shared/ so the renderer can type the board without
// importing main-process code. Re-exported here for existing importers.
export type { IssueStatus, IssueRow, IssueLabelRow }

export interface WebhookRow extends Row {
  token: string
  workspaceId: string
  actionId: string
  name: string
  filter?: string
  enabled: boolean
  createdAt: number
}

export type WebhookEventStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'expired' | 'filtered'

export interface WebhookEventRow extends Row {
  webhookId: string
  token: string
  workspaceId: string
  actionId: string
  payload: unknown
  status: WebhookEventStatus
  filterResult?: string
  filterPrompt?: string
  createdAt: number
  processedAt?: number
}

export interface PushSubscriptionRow extends Row {
  endpoint: string
  p256dh: string
  auth: string
  createdAt: number
}

export interface DurableStore {
  issues: Table<IssueRow>
  issueLabels: Table<IssueLabelRow>
  webhooks: Table<WebhookRow>
  webhookEvents: Table<WebhookEventRow>
  pushSubscriptions: Table<PushSubscriptionRow>
}

let cached: DurableStore | null = null

export function getDurableStore(): DurableStore {
  if (cached) return cached
  // Its own file rather than the app's main store: this is phone-facing data
  // with a different lifetime from window state and settings, and keeping it
  // separate makes it safe to delete on its own.
  const store = new Store<Record<string, unknown>>({ name: 'remote-data' })
  cached = {
    issues: new Table<IssueRow>(store, 'issues'),
    issueLabels: new Table<IssueLabelRow>(store, 'issueLabels'),
    webhooks: new Table<WebhookRow>(store, 'webhooks'),
    webhookEvents: new Table<WebhookEventRow>(store, 'webhookEvents'),
    pushSubscriptions: new Table<PushSubscriptionRow>(store, 'pushSubscriptions'),
  }
  return cached
}

/** Test seam. */
export function setDurableStore(store: DurableStore | null): void {
  cached = store
}
