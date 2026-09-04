type ParameterVersionForBaseline = {
  valid: boolean
  version: string
  executedAtBlock: string
  firstCheckpoint: string | null
}

export type ProposalBaselineUnavailableReason =
  | 'recovered-proposal'
  | 'invalid-history'
  | 'same-block-order'
  | 'no-candidates'
  | 'invalid-reconstruction'
  | 'root-mismatch'
  | 'ambiguous-root'

export type ProposalBaselineReconstruction<Version, Result> =
  | { status: 'verified'; version: Version; result: Result }
  | { status: 'unavailable'; reason: ProposalBaselineUnavailableReason }

export type ProposalProofSelection<Proof> =
  | { status: 'verified'; proof: Proof }
  | { status: 'unavailable'; reason: 'no-proof' | 'same-block-proof' }

const BYTES32 = /^0x[0-9a-fA-F]{64}$/

const bigintOrUndefined = (value: string): bigint | undefined => {
  try {
    return BigInt(value)
  } catch {
    return undefined
  }
}

/** Pick the newest proof block, but reject a tie because proof rows omit transaction/log order. */
export const selectProposalProof = <Proof extends { blockNumber: bigint }>(
  proofs: readonly Proof[] | undefined
): ProposalProofSelection<Proof> => {
  if (!proofs || proofs.length === 0) {
    return { status: 'unavailable', reason: 'no-proof' }
  }
  const newestBlock = proofs.reduce(
    (latest, proof) =>
      proof.blockNumber > latest ? proof.blockNumber : latest,
    proofs[0]!.blockNumber
  )
  const newest = proofs.filter((proof) => proof.blockNumber === newestBlock)
  return newest.length === 1
    ? { status: 'verified', proof: newest[0]! }
    : { status: 'unavailable', reason: 'same-block-proof' }
}

/**
 * Reconstruct every checkpoint-eligible parameter version and accept a baseline only when exactly
 * one version produces the proposal's committed root. Block/version ordering only excludes
 * impossible candidates; it never authenticates a baseline.
 */
export const reconstructProposalBaseline = <
  Version extends ParameterVersionForBaseline,
  Result,
>({
  versions,
  proposalBlock,
  checkpointId,
  expectedRoot,
  reconstruct,
}: {
  versions: readonly Version[] | undefined
  proposalBlock: bigint
  checkpointId: bigint
  expectedRoot: string
  reconstruct: (version: Version) => { root: string; result: Result }
}): ProposalBaselineReconstruction<Version, Result> => {
  // Setup-recovered proposals deliberately carry block zero because their creation event was not
  // indexed. Do not pretend that this sentinel orders them against parameter history.
  if (proposalBlock <= 0n) {
    return { status: 'unavailable', reason: 'recovered-proposal' }
  }
  if (checkpointId < 0n || !BYTES32.test(expectedRoot) || !versions) {
    return { status: 'unavailable', reason: 'invalid-history' }
  }

  const candidates: Version[] = []
  for (const version of versions) {
    if (!version.valid) continue
    const versionNumber = bigintOrUndefined(version.version)
    const executedAtBlock = bigintOrUndefined(version.executedAtBlock)
    const firstCheckpoint =
      version.firstCheckpoint === null
        ? undefined
        : bigintOrUndefined(version.firstCheckpoint)
    if (
      versionNumber === undefined ||
      versionNumber < 0n ||
      executedAtBlock === undefined ||
      executedAtBlock < 0n ||
      (version.firstCheckpoint !== null &&
        (firstCheckpoint === undefined || firstCheckpoint < 0n))
    ) {
      return { status: 'unavailable', reason: 'invalid-history' }
    }
    // An unpinned version cannot have produced any checkpoint root. A version first pinned after
    // this proof cannot have produced this one either.
    if (firstCheckpoint === undefined || firstCheckpoint > checkpointId) {
      continue
    }
    if (executedAtBlock > proposalBlock) continue
    // The index exposes no transaction/log position for parameter versions or recovered proposal
    // rows. Even a matching root cannot prove that a same-block version existed before propose().
    if (executedAtBlock === proposalBlock) {
      return { status: 'unavailable', reason: 'same-block-order' }
    }
    candidates.push(version)
  }

  if (candidates.length === 0) {
    return { status: 'unavailable', reason: 'no-candidates' }
  }

  const matches: Array<{ version: Version; result: Result }> = []
  for (const version of candidates) {
    try {
      const candidate = reconstruct(version)
      if (!BYTES32.test(candidate.root)) {
        return { status: 'unavailable', reason: 'invalid-reconstruction' }
      }
      if (candidate.root.toLowerCase() === expectedRoot.toLowerCase()) {
        matches.push({ version, result: candidate.result })
      }
    } catch {
      // A broken candidate could have been the matching one. Ignoring it would turn incomplete
      // evidence into a seemingly unique answer.
      return { status: 'unavailable', reason: 'invalid-reconstruction' }
    }
  }

  if (matches.length === 0) {
    return { status: 'unavailable', reason: 'root-mismatch' }
  }
  if (matches.length !== 1) {
    return { status: 'unavailable', reason: 'ambiguous-root' }
  }
  return {
    status: 'verified',
    version: matches[0]!.version,
    result: matches[0]!.result,
  }
}
