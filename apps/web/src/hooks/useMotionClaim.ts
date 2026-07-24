'use client'
import { useEffect, useRef, useState } from 'react'
import { RestDetector } from '../lib/motion-rest'

/**
 * iOS 13+ puts the motion sensors behind an explicit grant that can only be
 * requested from inside a user gesture. Other engines (Android Chrome) expose
 * `devicemotion` ungated and never define this.
 */
type MotionPermission = 'granted' | 'denied' | 'prompt'
interface GatedDeviceMotionEvent {
  requestPermission?: () => Promise<MotionPermission>
}

/**
 * Ask for the motion sensors, returning true once they're usable.
 *
 * The eager call covers a returning user: an origin that already granted
 * resolves without a prompt, so nothing is required of them. On a fresh origin
 * that same call REJECTS (no user gesture behind it) rather than resolving —
 * which is why a one-shot arm stays on `pointerdown` until we get a real answer.
 * Any tap anywhere in the app then triggers the system prompt, once.
 *
 * Deliberately independent of whether we're currently sampling: the phone
 * usually owns the geometry already (nothing to claim, so no listener), and if
 * the grant waited for that to stop being true, the very first hand-off back to
 * the desktop would find us unpermitted and silently do nothing.
 */
function useMotionPermission(): boolean {
  const [granted, setGranted] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof DeviceMotionEvent === 'undefined') return
    const request = (DeviceMotionEvent as unknown as GatedDeviceMotionEvent).requestPermission
    if (typeof request !== 'function') {
      setGranted(true) // ungated engine
      return
    }

    let disposed = false
    const onGesture = (): void => void ask()
    const disarm = (): void => window.removeEventListener('pointerdown', onGesture, true)
    const ask = async (): Promise<void> => {
      try {
        const result = await request.call(DeviceMotionEvent)
        // Answered — granted or not, stop asking on every tap.
        disarm()
        if (!disposed && result === 'granted') setGranted(true)
      } catch {
        // No user gesture behind this call (or no sensor at all); leave the arm
        // in place so the next tap anywhere retries.
      }
    }

    window.addEventListener('pointerdown', onGesture, true)
    void ask()
    return () => {
      disposed = true
      disarm()
    }
  }, [])

  return granted
}

/**
 * Fire `onMotion` when the phone goes from at-rest to being handled while the
 * page is in the foreground — "I picked my phone up, this screen is the one I'm
 * looking at now". The caller turns that into a geometry claim, so the shared
 * PTY reflows to the phone exactly as tapping the worktree name does.
 *
 * Two things keep a pocketed or desk-bound phone from stealing the size:
 *  - the page must be visible (a locked phone's PWA is hidden, and browsers
 *    stop delivering `devicemotion` to hidden pages anyway), and
 *  - motion must be SUSTAINED, not a spike — see RestDetector for the model.
 *
 * `enabled` should be false when there's nothing to claim (no session) or the
 * phone already owns the geometry; the sensor listener is torn down entirely
 * then, so an idle phone isn't paying for it.
 */
export function useMotionClaim(enabled: boolean, onMotion: () => void): void {
  // Ref so a new callback identity each render doesn't re-subscribe the sensor
  // (and reset the detector's burst/cooldown state with it).
  const onMotionRef = useRef(onMotion)
  onMotionRef.current = onMotion
  const granted = useMotionPermission()

  useEffect(() => {
    if (!enabled || !granted) return

    const detector = new RestDetector()
    const onDeviceMotion = (e: DeviceMotionEvent): void => {
      // Backgrounded: drop the burst in progress so the samples from before and
      // after the gap aren't read as one continuous movement.
      if (document.visibilityState !== 'visible') {
        detector.reset()
        return
      }
      const a = e.accelerationIncludingGravity
      const r = e.rotationRate
      const fired = detector.sample({
        accel: a ? { x: a.x ?? 0, y: a.y ?? 0, z: a.z ?? 0 } : null,
        // rotationRate is (alpha, beta, gamma); only the magnitude matters here.
        rotation: r ? { x: r.alpha ?? 0, y: r.beta ?? 0, z: r.gamma ?? 0 } : null,
        // performance.now() rather than e.timeStamp: some engines report 0 there.
        t: performance.now(),
      })
      if (fired) onMotionRef.current()
    }

    window.addEventListener('devicemotion', onDeviceMotion)
    return () => window.removeEventListener('devicemotion', onDeviceMotion)
  }, [enabled, granted])
}
