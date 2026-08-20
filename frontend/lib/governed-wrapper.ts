//! The surface every governed wrapper factory shares (network-creation GOAL M4).
//!
//! `GovernedTrustgraphsFactory`, `GovernedWeightedTrustgraphsFactory`, and
//! `GovernedTrustComposeFactory` deliberately expose the SAME governance profile constants, the
//! SAME `GovernedInstanceCreated` signature, and the SAME `InitialPolicy`/`SignerSyncConfig`
//! structs; only their `CreateArgs` tuples differ. The per-program `createGovernedInstance` ABIs
//! are hand-audited next to each program's own contracts seam
//! (`lib/weighted-prior/contracts.ts`, `lib/composition/contracts.ts`); everything
//! program-agnostic lives here so the wizard and both workspaces read one source of truth.

import { type Address, type Hex, parseAbi, zeroAddress } from 'viem'

/** Program-agnostic reads and the shared creation event, identical across all three wrappers. */
export const governedWrapperAbi = parseAbi([
  'event GovernedInstanceCreated(bytes32 indexed instanceId,address indexed creator,address indexed safe,address merkleGovModule,address snapshot)',
  'function MEMBER_VOTING_DELAY() view returns (uint256)',
  'function MEMBER_VOTING_PERIOD() view returns (uint256)',
  'function MEMBER_EXECUTION_DELAY() view returns (uint256)',
  'function RECOVERY_DELAY() view returns (uint48)',
])

/** The optional creation-time proving policy tuple (`InitialPolicy`), for ABI templates. */
export const INITIAL_POLICY_TUPLE =
  '(uint64 minPaidIntervalBlocks,uint96 maxPerRootUsd)'

/** The optional signer-sync module config tuple (`SignerSyncConfig`), for ABI templates. */
export const SIGNER_SYNC_TUPLE =
  '(bool enabled,address verifier,bytes32 programVKey,uint32 topN,uint32 minThreshold,uint32 targetThresholdBps)'

/**
 * The wrappers' shared error surface, for ABI templates: including these lets simulation failures
 * decode to named errors instead of raw revert bytes.
 */
export const GOVERNED_WRAPPER_ERRORS = [
  'error ZeroAddress()',
  'error SafeFundingFailed()',
  'error SafeExecutionFailed(address target, bytes data)',
  'error InstanceDiscoveryFailed(bytes32 instanceId)',
  'error PrepayRequiresPolicy()',
  'error PolicyRequiresPrepay()',
  'error PrepayUnavailable()',
  'error InitialPaidIntervalTooShort(uint64 supplied, uint64 minimum)',
  'error InitialCapTooHigh(uint96 supplied, uint96 maximum)',
  'error InitialFeeUnpriced(bytes32 program, uint8 band)',
  'error InitialCapBelowFee(uint96 supplied, uint256 feeUsd)',
  'error GovernanceDefaultsMismatch()',
] as const

/**
 * The explicit "not offered" signer-sync config (GOAL clarification 8): the wrappers accept the
 * struct, but the only signer guest today proves the standard trust-graph selection pipeline, so
 * the weighted and composition paths always pass this disabled value.
 */
export const DISABLED_SIGNER_SYNC = {
  enabled: false,
  verifier: zeroAddress as Address,
  programVKey: `0x${'0'.repeat(64)}` as Hex,
  topN: 0,
  minThreshold: 0,
  targetThresholdBps: 0,
} as const

/** The live-read governance profile of a governed wrapper factory. */
export type AuthorityProfile = {
  loading: boolean
  /** Blocks between a proposal and the start of voting. */
  memberVotingDelay?: bigint
  /** Blocks the vote stays open. */
  memberVotingPeriod?: bigint
  /** Blocks between a passed vote and Safe execution. */
  memberExecutionDelay?: bigint
  /** Seconds the delayed recovery module enforces. */
  recoveryDelay?: bigint
  /**
   * The sealed-authority check the main wizard's review screen enforces: all four profile reads
   * answered, every member delay is nonzero, and recovery waits at least 14 days. Creation is
   * disabled against a factory that fails this, so the app cannot market an ungraduated network.
   */
  valid: boolean
}

/** A duration in words, from seconds (the recovery and activation delays are second-based). */
export const describeSeconds = (
  seconds: bigint | number | undefined
): string => {
  if (seconds === undefined) return 'an unknown time'
  const value = Number(seconds)
  if (!Number.isFinite(value) || value <= 0) return 'no extra time'
  if (value < 3_600) return `${Math.max(1, Math.round(value / 60))} minutes`
  if (value < 86_400) return `${Math.round(value / 3_600)} hours`
  const days = value / 86_400
  return days === 1 ? '1 day' : `${Math.round(days * 10) / 10} days`
}
