// "Is the phone being handled?" from the accelerometer, as a pure reducer so the
// thresholds can be unit-tested without a device. useMotionClaim owns the sensor
// plumbing (permission, listener, visibility) and defers every decision here.
//
// Model: a phone lying on a desk is not perfectly still — the accelerometer
// reports sensor noise, and a bumped table produces a sharp one-frame spike. So
// "not at rest" is deliberately NOT "any reading changed". It is *sustained*
// activity: the motion has to stay above threshold for SUSTAIN_MS before it
// counts, which separates picking the phone up (hundreds of ms of continuous
// movement) from a knock, a passing truck, or sensor jitter.

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface MotionSample {
  /** accelerationIncludingGravity, m/s². Null when the device omits it. */
  accel: Vec3 | null
  /** rotationRate as (alpha, beta, gamma) in deg/s. Null without a gyroscope. */
  rotation: Vec3 | null
  /** Monotonic timestamp in ms (performance.now()). */
  t: number
}

/**
 * Frame-to-frame change in the gravity-included acceleration vector, in m/s²,
 * that counts as movement. Resting noise sits well under 0.1; a hand lifting or
 * tilting the phone is comfortably over 1.
 */
export const ACCEL_DELTA_THRESHOLD = 0.55

/**
 * Rotation, in deg/s, that counts as movement on its own. Catches the case the
 * accelerometer is weakest at: turning the phone slowly and smoothly enough
 * that the gravity vector creeps rather than jumps. A phone held still in a
 * hand drifts a few deg/s.
 */
export const ROTATION_THRESHOLD = 12

/** How long motion must persist before it counts. Rejects one-off knocks. */
export const SUSTAIN_MS = 300

/**
 * Quiet stretch that ends a burst. Real handling dips below threshold
 * constantly (the hand pauses at the top of a lift), so a single calm frame
 * must not restart the SUSTAIN_MS clock.
 */
export const REST_GAP_MS = 250

/**
 * Minimum gap between two fires. The claim it triggers resizes every PTY, so
 * carrying the phone around must not re-fire it every 300ms.
 */
export const COOLDOWN_MS = 5_000

function finite(n: number | null | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

/**
 * Feed it devicemotion samples; it returns true on the frame where the phone
 * has gone from at-rest to being handled (and is off cooldown). Stateful and
 * single-use per listener — construct one per mount, `reset()` when sampling
 * pauses (page hidden) so the burst in progress doesn't survive the gap.
 */
export class RestDetector {
  private prev: Vec3 | null = null
  private activeSince: number | null = null
  private lastActiveAt = 0
  private lastFireAt = Number.NEGATIVE_INFINITY

  /** Forget the in-flight burst. Keeps the cooldown — that's a rate limit, not burst state. */
  reset(): void {
    this.prev = null
    this.activeSince = null
    this.lastActiveAt = 0
  }

  sample(s: MotionSample): boolean {
    if (!this.isMoving(s)) {
      if (this.activeSince !== null && s.t - this.lastActiveAt >= REST_GAP_MS) this.activeSince = null
      return false
    }
    this.lastActiveAt = s.t
    if (this.activeSince === null) {
      this.activeSince = s.t
      return false
    }
    if (s.t - this.activeSince < SUSTAIN_MS) return false
    if (s.t - this.lastFireAt < COOLDOWN_MS) return false
    this.lastFireAt = s.t
    // Start a fresh burst so holding the phone doesn't fire again the instant
    // the cooldown lapses — it takes another SUSTAIN_MS of movement.
    this.activeSince = null
    return true
  }

  private isMoving(s: MotionSample): boolean {
    let moving = false
    if (s.accel) {
      const cur = { x: finite(s.accel.x), y: finite(s.accel.y), z: finite(s.accel.z) }
      const prev = this.prev
      this.prev = cur
      if (prev && Math.hypot(cur.x - prev.x, cur.y - prev.y, cur.z - prev.z) >= ACCEL_DELTA_THRESHOLD) {
        moving = true
      }
    }
    if (s.rotation) {
      const { x, y, z } = s.rotation
      if (Math.hypot(finite(x), finite(y), finite(z)) >= ROTATION_THRESHOLD) moving = true
    }
    return moving
  }
}
