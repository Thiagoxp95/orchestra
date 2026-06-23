import { powerMonitor } from 'electron'
import { anyApi } from 'convex/server'
import { DEVICE_SECRET } from './convex-config'
import { getRemoteClient, isRemoteBridgeEnabled } from './remote-bridge'

/** Seconds the Mac must be idle before phone pushes fire. */
export const IDLE_THRESHOLD_SECONDS = 120

/** Pure gate: only push to the phone once the user is away from the Mac. */
export function shouldRemoteNotify(idleSeconds: number, thresholdSeconds: number): boolean {
  return idleSeconds >= thresholdSeconds
}

export interface RemoteNotifyInput {
  title: string
  body: string
  sessionId: string
  requiresUserInput: boolean
}

/** Fire a web push for an idle/needs-input event. No-op when the bridge is
 *  disabled or the user is actively at the Mac. Never throws into the caller. */
export function remoteBridgeNotify(input: RemoteNotifyInput): void {
  if (!isRemoteBridgeEnabled()) return
  const idle = powerMonitor.getSystemIdleTime()
  if (!shouldRemoteNotify(idle, IDLE_THRESHOLD_SECONDS)) return
  void getRemoteClient()
    .mutation(anyApi.remote.notify, { secret: DEVICE_SECRET, ...input })
    .catch((err: unknown) => console.warn('[remote-bridge] notify failed:', err))
}
