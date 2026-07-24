import { describe, expect, it } from 'vitest'
import {
  RestDetector,
  ACCEL_DELTA_THRESHOLD,
  ROTATION_THRESHOLD,
  SUSTAIN_MS,
  REST_GAP_MS,
  COOLDOWN_MS,
} from './motion-rest'

const GRAVITY = { x: 0, y: 0, z: 9.81 }
const STEP_MS = 20

/** Square wave over sample index, so consecutive samples always differ. */
function alternate(t: number, amplitude: number): number {
  return (Math.floor(t / STEP_MS) % 2) * amplitude
}

/** A phone on a desk: the reading barely moves. */
function restSample(t: number) {
  // Tiny noise, so consecutive samples still differ (as they do on a real
  // device) but never by enough to count.
  return { accel: { ...GRAVITY, x: alternate(t, 0.02) }, rotation: { x: 1, y: 1, z: 1 }, t }
}

/** A phone in a hand: every frame swings well past the threshold. */
function movingSample(t: number) {
  const swing = alternate(t, ACCEL_DELTA_THRESHOLD * 4)
  return { accel: { ...GRAVITY, x: swing }, rotation: { x: 0, y: 0, z: 0 }, t }
}

/** Feed samples every `stepMs` from `from` to `to`; return the fire timestamps. */
function feed(
  d: RestDetector,
  make: (t: number) => ReturnType<typeof restSample>,
  from: number,
  to: number,
  stepMs = STEP_MS,
): number[] {
  const fires: number[] = []
  for (let t = from; t <= to; t += stepMs) if (d.sample(make(t))) fires.push(t)
  return fires
}

describe('RestDetector', () => {
  it('never fires while the phone sits still', () => {
    expect(feed(new RestDetector(), restSample, 0, 10_000)).toEqual([])
  })

  it('fires once sustained handling passes SUSTAIN_MS', () => {
    const d = new RestDetector()
    const fires = feed(d, movingSample, 0, SUSTAIN_MS + 200)
    expect(fires).toHaveLength(1)
    // Not before the sustain window has elapsed.
    expect(fires[0]).toBeGreaterThanOrEqual(SUSTAIN_MS)
  })

  it('ignores a single sharp knock (a bumped desk)', () => {
    const d = new RestDetector()
    d.sample(restSample(0))
    // One violent frame, then back to rest for well past the sustain window.
    d.sample({ accel: { x: 0, y: 0, z: 30 }, rotation: null, t: 20 })
    expect(feed(d, restSample, 40, 2_000)).toEqual([])
  })

  it('treats a brief dip mid-gesture as one continuous burst', () => {
    const d = new RestDetector()
    // Move, pause shorter than REST_GAP_MS, move again — the pause must not
    // restart the sustain clock, so the total still fires at ~SUSTAIN_MS.
    feed(d, movingSample, 0, 200)
    const gap = REST_GAP_MS - 50
    feed(d, restSample, 220, 220 + gap)
    const fires = feed(d, movingSample, 220 + gap + 20, 220 + gap + 400)
    expect(fires).toHaveLength(1)
  })

  it('restarts the sustain clock after a real rest gap', () => {
    const d = new RestDetector()
    feed(d, movingSample, 0, 200) // 200ms of motion — short of SUSTAIN_MS
    feed(d, restSample, 220, 220 + REST_GAP_MS + 100) // settles
    // A second burst has to earn its own full SUSTAIN_MS.
    const start = 400 + REST_GAP_MS
    expect(feed(d, movingSample, start, start + SUSTAIN_MS - 60)).toEqual([])
  })

  it('rate-limits continuous handling to one fire per cooldown', () => {
    const d = new RestDetector()
    // 12.5s of nonstop movement: the first fire lands after the sustain window,
    // the rest are spaced by the cooldown — not one per frame.
    const fires = feed(d, movingSample, 0, COOLDOWN_MS * 2.5)
    expect(fires).toHaveLength(3)
    for (let i = 1; i < fires.length; i++) {
      expect(fires[i] - fires[i - 1]).toBeGreaterThanOrEqual(COOLDOWN_MS)
    }
  })

  it('detects a slow tilt from rotation alone', () => {
    const d = new RestDetector()
    // Gravity vector unchanged frame to frame; only the gyroscope reports it.
    const tilt = (t: number) => ({
      accel: GRAVITY,
      rotation: { x: ROTATION_THRESHOLD + 5, y: 0, z: 0 },
      t,
    })
    expect(feed(d, tilt, 0, SUSTAIN_MS + 100)).toHaveLength(1)
  })

  it('tolerates a device that reports no rotation and null components', () => {
    const d = new RestDetector()
    const noisy = (t: number) => ({
      accel: { ...GRAVITY, x: alternate(t, ACCEL_DELTA_THRESHOLD * 4) },
      rotation: { x: NaN, y: null as unknown as number, z: undefined as unknown as number },
      t,
    })
    expect(feed(d, noisy, 0, SUSTAIN_MS + 100)).toHaveLength(1)
  })

  it('drops the in-flight burst on reset but keeps the cooldown', () => {
    const d = new RestDetector()
    const fires = feed(d, movingSample, 0, SUSTAIN_MS + 100)
    expect(fires).toHaveLength(1)
    d.reset()
    // Backgrounded and returned: still inside the cooldown, so no second fire.
    expect(feed(d, movingSample, 1_000, 1_000 + SUSTAIN_MS + 100)).toEqual([])
  })
})
