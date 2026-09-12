import { expect, test } from 'vitest'
import { captureInputLease, assertInputLease, makeDictationId } from './input-lease'

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
test('dictation identity preserves the originating stream lease and leaves legacy identities intact', () => {
  expect(makeDictationId('utterance', 'lease-a')).toBe('stream:lease-a:utterance')
  expect(makeDictationId('utterance', undefined)).toBe('utterance')
  expect(() => assertInputLease(undefined, undefined)).not.toThrow()
})
