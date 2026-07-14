// The frontend's generated `merkleSnapshotAbi` (frontend/lib/contract-abis.ts) is produced by wagmi
// from a forge artifact that predates the journal-v2 additions, so it is missing the lane-2
// `AnchorsCheckpointed` event. Rather than regenerate the whole frontend ABI pipeline from here
// (out of scope for the indexer), append the one missing event fragment and re-export a merged ABI.
//
// The rest of MerkleSnapshot's surface the indexer uses (getStateCount / getStateAtIndex reads,
// MerkleRootUpdated) is unchanged between the two artifacts — verified against
// out/MerkleSnapshot.sol/MerkleSnapshot.json — so the base import stays authoritative for those.
//
// When the frontend wagmi pipeline is refreshed against the journal-v2 artifact, drop this file and
// import `merkleSnapshotAbi` directly from ../../frontend/lib/contract-abis again.
import { merkleSnapshotAbi as baseMerkleSnapshotAbi } from '../../frontend/lib/contract-abis'

// Fragment lifted verbatim from out/MerkleSnapshot.sol/MerkleSnapshot.json.
const anchorsCheckpointedEvent = {
  type: 'event',
  name: 'AnchorsCheckpointed',
  inputs: [
    {
      name: 'checkpointId',
      type: 'uint256',
      indexed: true,
      internalType: 'uint256',
    },
    {
      name: 'anchorAcc',
      type: 'bytes32',
      indexed: false,
      internalType: 'bytes32',
    },
    {
      name: 'anchorCount',
      type: 'uint64',
      indexed: false,
      internalType: 'uint64',
    },
  ],
  anonymous: false,
} as const

export const merkleSnapshotAbi = [
  ...baseMerkleSnapshotAbi,
  anchorsCheckpointedEvent,
] as const
