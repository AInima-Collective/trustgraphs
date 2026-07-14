import { index, onchainTable, primaryKey } from 'ponder'

export const easAttestation = onchainTable(
  'eas_attestation',
  (t) => ({
    uid: t.hex().primaryKey(),
    schema: t.hex().notNull(),
    resolver: t.hex().notNull(),
    attester: t.hex().notNull(),
    recipient: t.hex().notNull(),
    ref: t.hex().notNull(),
    revocable: t.boolean().notNull(),
    expirationTime: t.bigint().notNull(),
    revocationTime: t.bigint().notNull(),
    data: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (t) => ({
    schemaIdx: index().on(t.schema),
    resolverIdx: index().on(t.resolver),
    attesterIdx: index().on(t.attester),
    recipientIdx: index().on(t.recipient),
    refIdx: index().on(t.ref),
    blockNumberIdx: index().on(t.blockNumber),
    timestampIdx: index().on(t.timestamp),
  })
)

export const merkleSnapshot = onchainTable(
  'merkle_snapshot',
  (t) => ({
    id: t.text().primaryKey(),
    address: t.hex().notNull(),
    chainId: t.text().notNull(),
    root: t.hex().notNull(),
    ipfsHash: t.hex().notNull(),
    ipfsHashCid: t.text().notNull(),
    totalValue: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (t) => ({
    addressIdx: index().on(t.address),
    chainIdIdx: index().on(t.chainId),
    rootIdx: index().on(t.root),
    ipfsHashCidIdx: index().on(t.ipfsHashCid),
    blockNumberIdx: index().on(t.blockNumber),
    timestampIdx: index().on(t.timestamp),
  })
)

/*///////////////////////////////////////////////////////////////
              LANE 2 — offchain-attestation anchors (M2)
//////////////////////////////////////////////////////////////*/

// AnchorRegistry.HeadAnchored — one row per anchor claim folded into the lane-2 chained-hash log
// (OFFCHAIN_ATTESTATIONS_ZK §4.1). `foldIndex` is the leaf's position in the chain; `head` is the
// per-identity completeness commitment; `dataCommitment` is where the data behind the head lives.
// Single-instance for M2 (the multi-instance `instanceId` dimension is deferred to M4/M5); `address`
// is carried only for provenance across a redeploy, not as an instance key.
export const anchor = onchainTable(
  'anchor',
  (t) => ({
    id: t.text().primaryKey(), // event log id (unique per HeadAnchored)
    address: t.hex().notNull(), // AnchorRegistry that emitted it
    foldIndex: t.bigint().notNull(), // uint64 — leaf position in the fold
    nodeId: t.hex().notNull(),
    envelopeKind: t.integer().notNull(), // uint8 — 0 = EAS-offchain, 1 = atproto, ...
    head: t.hex().notNull(),
    dataCommitment: t.hex().notNull(),
    blockTimestamp: t.bigint().notNull(), // the on-chain timestamp folded into the leaf
    txHash: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
  }),
  (t) => ({
    addressIdx: index().on(t.address),
    foldIndexIdx: index().on(t.foldIndex),
    nodeIdIdx: index().on(t.nodeId),
    envelopeKindIdx: index().on(t.envelopeKind),
    headIdx: index().on(t.head),
    blockTimestampIdx: index().on(t.blockTimestamp),
    blockNumberIdx: index().on(t.blockNumber),
  })
)

// AnchorRegistry.NodeRegistered — one row per registered node. Registration is once-per-node (the
// contract's AlreadyRegistered guard), so `nodeId` is the natural primary key.
export const nodeRegistration = onchainTable(
  'node_registration',
  (t) => ({
    nodeId: t.hex().primaryKey(),
    address: t.hex().notNull(), // AnchorRegistry that emitted it
    kind: t.integer().notNull(), // uint8 — 0 = address, 1 = DID, ...
    registrant: t.hex().notNull(),
    at: t.bigint().notNull(), // block.timestamp of registration
    txHash: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
  }),
  (t) => ({
    addressIdx: index().on(t.address),
    kindIdx: index().on(t.kind),
    registrantIdx: index().on(t.registrant),
    atIdx: index().on(t.at),
  })
)

// MerkleSnapshot.AnchorsCheckpointed — the lane-2 accumulator frozen at each snapshot trigger. One
// row per checkpoint id; `anchorAcc`/`anchorCount` are what the guest consumes for that epoch (zeros
// for a lane-1-only instance with no AnchorRegistry).
export const anchorCheckpoint = onchainTable(
  'anchor_checkpoint',
  (t) => ({
    checkpointId: t.bigint().primaryKey(), // uint256
    address: t.hex().notNull(), // MerkleSnapshot that emitted it
    anchorAcc: t.hex().notNull(),
    anchorCount: t.bigint().notNull(), // uint64
    blockTimestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
  }),
  (t) => ({
    addressIdx: index().on(t.address),
    anchorAccIdx: index().on(t.anchorAcc),
    blockNumberIdx: index().on(t.blockNumber),
  })
)

export const merkleGovModule = onchainTable(
  'merkle_gov_module',
  (t) => ({
    address: t.hex().primaryKey(),
    avatar: t.hex().notNull(),
    target: t.hex().notNull(),
    merkleSnapshot: t.hex().notNull(),
    currentMerkleRoot: t.hex().notNull(),
    ipfsHash: t.hex().notNull(),
    ipfsHashCid: t.text().notNull(),
    totalVotingPower: t.bigint().notNull(),
    proposalCount: t.bigint().notNull(),
    votingDelay: t.bigint().notNull(),
    votingPeriod: t.bigint().notNull(),
    quorum: t.bigint().notNull(),
  }),
  (t) => ({
    avatarIdx: index().on(t.avatar),
    targetIdx: index().on(t.target),
    merkleSnapshotIdx: index().on(t.merkleSnapshot),
    currentMerkleRootIdx: index().on(t.currentMerkleRoot),
    ipfsHashCidIdx: index().on(t.ipfsHashCid),
  })
)

export const merkleGovModuleProposal = onchainTable(
  'merkle_gov_module_proposal',
  (t) => ({
    module: t.hex().notNull(),
    id: t.bigint().notNull(),
    proposer: t.hex().notNull(),
    title: t.text().notNull(),
    description: t.text().notNull(),
    startBlock: t.bigint().notNull(),
    endBlock: t.bigint().notNull(),
    yesVotes: t.bigint().notNull(),
    noVotes: t.bigint().notNull(),
    abstainVotes: t.bigint().notNull(),
    executed: t.boolean().notNull(),
    cancelled: t.boolean().notNull(),
    merkleRoot: t.hex().notNull(),
    totalVotingPower: t.bigint().notNull(),
    // Actions stored as JSON array: [{target, value, data, operation}]
    actions: t.json().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (t) => ({
    pk: primaryKey({ columns: [t.module, t.id] }),
    moduleIdx: index().on(t.module),
    idIdx: index().on(t.id),
    proposerIdx: index().on(t.proposer),
    startBlockIdx: index().on(t.startBlock),
    endBlockIdx: index().on(t.endBlock),
    executedIdx: index().on(t.executed),
    merkleRootIdx: index().on(t.merkleRoot),
    blockNumberIdx: index().on(t.blockNumber),
    timestampIdx: index().on(t.timestamp),
  })
)

export const merkleGovModuleVote = onchainTable(
  'merkle_gov_module_vote',
  (t) => ({
    module: t.hex().notNull(),
    proposalId: t.bigint().notNull(),
    voter: t.hex().notNull(),
    voteType: t.integer().notNull(), // 0 = No, 1 = Yes, 2 = Abstain
    votingPower: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (t) => ({
    pk: primaryKey({ columns: [t.module, t.proposalId, t.voter] }),
    moduleIdx: index().on(t.module),
    proposalIdIdx: index().on(t.proposalId),
    voterIdx: index().on(t.voter),
    voteTypeIdx: index().on(t.voteType),
    blockNumberIdx: index().on(t.blockNumber),
    timestampIdx: index().on(t.timestamp),
  })
)

export const merkleFundDistributor = onchainTable(
  'merkle_fund_distributor',
  (t) => ({
    address: t.hex().primaryKey(),
    chainId: t.text().notNull(),
    paused: t.boolean().notNull(),
    merkleSnapshot: t.hex().notNull(),
    owner: t.hex().notNull(),
    pendingOwner: t.hex().notNull(),
    feeRecipient: t.hex().notNull(),
    feePercentage: t.numeric().notNull(),
    allowlistEnabled: t.boolean().notNull(),
    allowlist: t.hex().array().notNull(),
  }),
  (t) => ({
    chainIdIdx: index().on(t.chainId),
    merkleSnapshotIdx: index().on(t.merkleSnapshot),
    ownerIdx: index().on(t.owner),
    pendingOwnerIdx: index().on(t.pendingOwner),
    feeRecipientIdx: index().on(t.feeRecipient),
  })
)

export const merkleFundDistribution = onchainTable(
  'merkle_fund_distribution',
  (t) => ({
    id: t.bigint().primaryKey(),
    merkleFundDistributor: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    root: t.hex().notNull(),
    ipfsHash: t.hex().notNull(),
    ipfsHashCid: t.text().notNull(),
    totalMerkleValue: t.bigint().notNull(),
    distributor: t.hex().notNull(),
    token: t.hex().notNull(),
    amountFunded: t.bigint().notNull(),
    amountDistributed: t.bigint().notNull(),
    feeRecipient: t.hex().notNull(),
    feeAmount: t.bigint().notNull(),
  }),
  (t) => ({
    merkleFundDistributorIdx: index().on(t.merkleFundDistributor),
    rootIdx: index().on(t.root),
    blockNumberIdx: index().on(t.blockNumber),
    timestampIdx: index().on(t.timestamp),
    distributorIdx: index().on(t.distributor),
    tokenIdx: index().on(t.token),
    feeRecipientIdx: index().on(t.feeRecipient),
  })
)

export const merkleFundDistributionClaim = onchainTable(
  'merkle_fund_distribution_claim',
  (t) => ({
    id: t.text().primaryKey(), // distributor-distributionIndex-account
    merkleFundDistributor: t.hex().notNull(),
    distributionIndex: t.bigint().notNull(),
    account: t.hex().notNull(),
    token: t.hex().notNull(),
    amount: t.bigint().notNull(),
    merkleValue: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (t) => ({
    merkleFundDistributorIdx: index().on(t.merkleFundDistributor),
    distributionIndexIdx: index().on(t.distributionIndex),
    accountIdx: index().on(t.account),
    tokenIdx: index().on(t.token),
    blockNumberIdx: index().on(t.blockNumber),
    timestampIdx: index().on(t.timestamp),
  })
)

export const gnosisSafe = onchainTable(
  'gnosis_safe',
  (t) => ({
    address: t.hex().notNull(),
    chainId: t.text().notNull(),
    owners: t.hex().array().notNull(),
    threshold: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (t) => ({
    pk: primaryKey({ columns: [t.chainId, t.address] }),
    chainIdIdx: index().on(t.chainId),
    addressIdx: index().on(t.address),
    thresholdIdx: index().on(t.threshold),
    blockNumberIdx: index().on(t.blockNumber),
    timestampIdx: index().on(t.timestamp),
  })
)
