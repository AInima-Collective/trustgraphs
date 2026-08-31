export type EasAttestationTimes = {
  time: bigint
  expirationTime: bigint
  revocationTime: bigint
}

export type EasFoldKind = 'attest' | 'revoke' | 'expire'

/**
 * The timestamp committed into an accumulator leaf comes from authenticated EAS storage, never
 * from the transaction that happened to feed an importer. Native resolver transactions have the
 * same timestamp today, but imported attestations may predate their fold by years.
 */
export const easFoldTimestamp = (
  attestation: EasAttestationTimes,
  kind: EasFoldKind
): bigint => {
  const timestamp =
    kind === 'attest'
      ? attestation.time
      : kind === 'revoke'
        ? attestation.revocationTime
        : attestation.expirationTime
  if (timestamp === 0n) {
    throw new Error(`EAS attestation has no ${kind} timestamp`)
  }
  return timestamp
}
