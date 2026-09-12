export type InputLeaseGetter = () => string | undefined

/** Capture once before an asynchronous upload/recording; never adopt a later grant. */
export function captureInputLease(getLease?: InputLeaseGetter): string | undefined {
  const lease = getLease?.()
  if (getLease && !lease) throw new Error('Terminal control changed')
  return lease
}
export function assertInputLease(getLease: InputLeaseGetter | undefined, captured: string | undefined): void {
  if (getLease && (!captured || getLease() !== captured)) throw new Error('Terminal control changed')
}
export function makeDictationId(uuid: string, lease: string | undefined): string {
  return lease ? `stream:${lease}:${uuid}` : uuid
}
