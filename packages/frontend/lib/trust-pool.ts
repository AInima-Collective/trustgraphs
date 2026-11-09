/**
 * A network's TrustPool (`contracts/src/governance/TrustPool.sol`): a delegatee that votes the
 * network's scores on an external fractional-voting governor (Gitcoin Governor Charlie). Holders
 * delegate their tokens to the pool; each scored member casts `poolVotes * score / totalScore` of
 * the pool's weight at the proposal's snapshot block.
 *
 * Pure on purpose (no React, no config) so `trust-pool.test.ts` runs under plain tsx.
 */
import { parseAbi } from 'viem'

import type { StateTone } from '@/components/ProposalStatus'

export const trustPoolAbi = parseAbi([
  'function governor() view returns (address)',
  'function snapshot() view returns (address)',
  'function hasVoted(uint256 proposalId, address account) view returns (bool)',
  'function proposalBasis(uint256 proposalId) view returns (bytes32 root, uint256 totalValue)',
  'function vote(uint256 proposalId, uint8 support, uint256 score, bytes32[] proof, string reason) returns (uint256 weight)',
])

/** The OZ Governor (with `GovernorCountingFractional`) reads the pages make. */
export const fractionalGovernorAbi = parseAbi([
  'function name() view returns (string)',
  'function token() view returns (address)',
  'function state(uint256 proposalId) view returns (uint8)',
  'function quorum(uint256 timepoint) view returns (uint256)',
  'function getVotes(address account, uint256 timepoint) view returns (uint256)',
  'function proposalVotes(uint256 proposalId) view returns (uint256 againstVotes, uint256 forVotes, uint256 abstainVotes)',
  'function usedVotes(uint256 proposalId, address account) view returns (uint256)',
])

/** A Compound-style votes token (GTC): delegation moves the whole balance's votes, no custody. */
export const compVotesTokenAbi = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
  'function delegates(address account) view returns (address)',
  'function getCurrentVotes(address account) view returns (uint96)',
  'function delegate(address delegatee)',
])

/** `IMerkleSnapshot.MerkleState`, field for field: the root a proposal's shares are measured by. */
export const merkleStateAbi = parseAbi([
  'struct MerkleState { uint256 blockNumber; uint256 timestamp; bytes32 root; bytes32 ipfsHash; string ipfsHashCid; uint256 totalValue; }',
  'function getLatestState() view returns (MerkleState)',
  'function getStateAtBlock(uint256 blockNumber) view returns (MerkleState)',
])

/** OZ `IGovernor.ProposalState`, in enum order. */
export const GOVERNOR_STATES = [
  'Pending',
  'Active',
  'Canceled',
  'Defeated',
  'Succeeded',
  'Queued',
  'Expired',
  'Executed',
] as const
export type GovernorState = (typeof GOVERNOR_STATES)[number]

export const governorStateLabel = (state: number | undefined): string =>
  (state !== undefined && GOVERNOR_STATES[state]) || 'Unknown'

/** OZ ProposalState → the governance tab's pill tones. */
export const governorStateTone = (state: number | undefined): StateTone =>
  state === 1
    ? 'active'
    : state === 4 || state === 5 || state === 7
      ? 'positive'
      : state === 3
        ? 'negative'
        : 'muted'

/** Active first (it can still be voted on), then Pending, then everything that is over. */
export const governorStatePriority = (state: number | undefined): number =>
  state === 1 ? 0 : state === 0 ? 1 : 2

/** Bravo `support` order, which is also `VoteType`'s: 0 Against, 1 For, 2 Abstain. */
export const SUPPORT_LABELS = ['Against', 'For', 'Abstain'] as const

/**
 * A proposal's title is the first line of its markdown description (the Tally convention:
 * `# Title`). Falls back to the id when the description starts with no text at all.
 */
export const proposalTitle = (
  description: string,
  proposalId: string
): string => {
  const firstLine = description
    .split('\n')
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find((line) => line.length > 0)
  return firstLine || `Proposal ${shortProposalId(proposalId)}`
}

/** The description without the title line it starts with, so the page does not repeat it. */
export const proposalBody = (description: string): string =>
  description.replace(/^\s*#[^\n]*\n?/, '').trim()

/** Governor ids are uint256 hashes: show the head and tail, never the whole number. */
export const shortProposalId = (proposalId: string): string =>
  proposalId.length > 12
    ? `${proposalId.slice(0, 6)}…${proposalId.slice(-4)}`
    : proposalId

/** A member's share of the pool, exactly as `TrustPool.vote` computes it (floor division). */
export const poolShare = (
  poolVotes: bigint,
  score: bigint,
  totalValue: bigint
): bigint => (totalValue === 0n ? 0n : (poolVotes * score) / totalValue)
