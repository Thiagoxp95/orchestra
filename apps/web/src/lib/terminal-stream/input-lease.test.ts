import { expect, test } from 'vitest'
import { captureInputLease, assertInputLease } from './input-lease'

test('stream ancillary input requires a live lease and rejects loss followed by a different grant', () => {
  let lease: string | undefined = 'original'
  const getLease = () => lease
  const captured = captureInputLease(getLease)
  lease = undefined
  expect(() => captureInputLease(getLease)).toThrow(/control/i)
  lease = 'replacement'
  expect(() => assertInputLease(getLease, captured)).toThrow(/control/i)
  expect(() => assertInputLease(getLease, captureInputLease(getLease))).not.toThrow()
})
test('no lease getter means no lease check', () => {
  expect(() => assertInputLease(undefined, undefined)).not.toThrow()
})
