import type { Hex } from 'viem'

/**
 * `MerkleFundDistributor.distribute` takes no unguarded form: a funder names the root, the payout
 * denominator that root committed, the fee it agreed to and who receives that fee, and the round
 * reverts if any of them moved. This module is the single place that builds those arguments, so a
 * screen cannot quietly fund against terms it never showed anyone.
 *
 * The ABI is deliberately a narrow fragment rather than the generated `merkleFundDistributorAbi`:
 * feeding the full ABI to `useReadContracts` exceeds TypeScript's instantiation depth (TS2589).
 */
export const fundingTermsAbi = [
  {
    type: 'function',
    name: 'feePercentage',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'FEE_RANGE',
    inputs: [],
    outputs: [{ type: 'uint64' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'feeRecipient',
    inputs: [],
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
  },
] as const

export const latestMerkleStateAbi = [
  {
    type: 'function',
    name: 'getLatestState',
    inputs: [],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'blockNumber', type: 'uint256' },
          { name: 'root', type: 'bytes32' },
          { name: 'ipfsHash', type: 'bytes32' },
          { name: 'ipfsHashCid', type: 'string' },
          { name: 'totalValue', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
] as const

export type FundingTerms = {
  token: Hex
  amount: bigint
  expectedRoot: Hex
  expectedTotalMerkleValue: bigint
  claimDeadline: bigint
  feePercentage: bigint
  feeRange: bigint
  feeRecipient: Hex
}

export type DistributeArgs = readonly [
  Hex,
  bigint,
  Hex,
  bigint,
  bigint,
  bigint,
  Hex,
]

/** The fee `distribute` will charge, computed exactly the way the contract computes it. */
export function quotedFee(
  amount: bigint,
  feePercentage: bigint,
  feeRange: bigint
): bigint {
  if (feeRange === 0n) throw new Error('FEE_RANGE is zero')
  return (amount * feePercentage) / feeRange
}

/** Build the seven arguments `distribute` requires, in ABI order. */
export function distributeArgs(terms: FundingTerms): DistributeArgs {
  return [
    terms.token,
    terms.amount,
    terms.expectedRoot,
    terms.expectedTotalMerkleValue,
    terms.claimDeadline,
    quotedFee(terms.amount, terms.feePercentage, terms.feeRange),
    terms.feeRecipient,
  ] as const
}
