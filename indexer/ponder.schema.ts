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

/*///////////////////////////////////////////////////////////////
        CONTRIBUTIONS PROGRAM — fold log + decoded records (M3)
//////////////////////////////////////////////////////////////*/

// The chained-hash accumulator fold log, one row per fold (attest AND revoke), for every
// accumulator-bearing resolver (the trust EASIndexerResolver instances, kinds {0, 1}, and the
// ContributionResolver, kinds 0–5 per docs/contributions/INTERFACES.md §2). This is the indexer's
// mirror of the exact `RawEdge` stream the ZK guest consumes: ordering by (block_number, log_index)
// is fold order (each fold emits exactly one AttestationAttested/AttestationRevoked marker), and
// `data` is the payload preimage of the folded `dataHash`. The derived-scoring recompute truncates
// this log to the checkpointed leaf counts and re-folds it, asserting the accumulator matches the
// chain before trusting anything derived from it.
export const accumulatorRecord = onchainTable(
  'accumulator_record',
  (t) => ({
    id: t.text().primaryKey(), // event log id (unique per fold marker event)
    accumulator: t.hex().notNull(), // the resolver/accumulator contract that folded it
    kind: t.integer().notNull(), // trust: 0 attest / 1 revoke; contributions: schemaIndex*2+isRevoke
    attester: t.hex().notNull(),
    recipient: t.hex().notNull(),
    uid: t.hex().notNull(),
    schema: t.hex().notNull(),
    data: t.hex().notNull(), // raw EAS attestation data (preimage of the folded dataHash)
    blockTimestamp: t.bigint().notNull(), // the block.timestamp folded into the leaf
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    txHash: t.hex().notNull(),
  }),
  (t) => ({
    accumulatorIdx: index().on(t.accumulator),
    uidIdx: index().on(t.uid),
    kindIdx: index().on(t.kind),
    foldOrderIdx: index().on(t.accumulator, t.blockNumber, t.logIndex),
  })
)

// contribution.claim attestations, decoded (INTERFACES.md §1 schema 0). `malformed = true` rows
// failed the guest's structural decoder (`decodeClaim`) and are provably inert in scoring — the
// row is kept (with whatever fields decoded) so the UI can show the attestation exists.
export const contributionClaim = onchainTable(
  'contribution_claim',
  (t) => ({
    uid: t.hex().primaryKey(),
    resolver: t.hex().notNull(),
    attester: t.hex().notNull(),
    recipient: t.hex().notNull(),
    title: t.text(), // display decode (null if malformed)
    contentHash: t.hex(),
    uri: t.text(),
    contributors: t.hex().array(), // as attested, in order (duplicates allowed)
    shares: t.bigint().array(), // uint32 weights, same order
    malformed: t.boolean().notNull(),
    revoked: t.boolean().notNull(),
    blockTimestamp: t.bigint().notNull(), // drives the round-window check
    blockNumber: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (t) => ({
    resolverIdx: index().on(t.resolver),
    attesterIdx: index().on(t.attester),
    revokedIdx: index().on(t.revoked),
    blockTimestampIdx: index().on(t.blockTimestamp),
  })
)

// Per-contributor attribution rows for a claim, shares aggregated per address (duplicates summed —
// the same aggregation reconciliation applies before normalizing). Serves the by-contributor API.
export const contributionClaimContributor = onchainTable(
  'contribution_claim_contributor',
  (t) => ({
    claimUid: t.hex().notNull(),
    contributor: t.hex().notNull(),
    share: t.bigint().notNull(), // aggregated raw weight (normalized per-claim at scoring time)
  }),
  (t) => ({
    pk: primaryKey({ columns: [t.claimUid, t.contributor] }),
    claimUidIdx: index().on(t.claimUid),
    contributorIdx: index().on(t.contributor),
  })
)

// contribution.response attestations (schema 1): accept/reject being named on a claim.
// `superseded = true` marks records replaced by a later live response from the same responder for
// the same claim (last-write-wins surfaced as a flag rather than deletion); a revocation of the
// latest response un-supersedes the previous one, mirroring the guest's reconciliation.
export const contributionResponse = onchainTable(
  'contribution_response',
  (t) => ({
    uid: t.hex().primaryKey(),
    resolver: t.hex().notNull(),
    claimUid: t.hex(), // null if malformed
    responder: t.hex().notNull(), // the attester
    response: t.integer(), // 1 = accept, 2 = reject (null if malformed)
    malformed: t.boolean().notNull(),
    superseded: t.boolean().notNull(),
    revoked: t.boolean().notNull(),
    blockTimestamp: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(), // LWW tiebreak within a block (fold order)
    txHash: t.hex().notNull(),
  }),
  (t) => ({
    resolverIdx: index().on(t.resolver),
    claimUidIdx: index().on(t.claimUid),
    responderIdx: index().on(t.responder),
  })
)

// contribution.valuation attestations (schema 2): 0–100 scores. Same LWW `superseded` semantics as
// responses (one live valuation per (rater, claim)).
export const contributionValuation = onchainTable(
  'contribution_valuation',
  (t) => ({
    uid: t.hex().primaryKey(),
    resolver: t.hex().notNull(),
    claimUid: t.hex(), // null if malformed
    rater: t.hex().notNull(), // the attester
    score: t.integer(), // 0–100 (null if malformed)
    malformed: t.boolean().notNull(),
    superseded: t.boolean().notNull(),
    revoked: t.boolean().notNull(),
    blockTimestamp: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    txHash: t.hex().notNull(),
  }),
  (t) => ({
    resolverIdx: index().on(t.resolver),
    claimUidIdx: index().on(t.claimUid),
    raterIdx: index().on(t.rater),
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
    // M6 expiry + sweep: claims close at `claimDeadline` (unix seconds; 0 = no deadline), after
    // which the funder can sweep the unclaimed remainder back (`Swept`).
    claimDeadline: t.bigint().notNull(),
    sweptAmount: t.bigint().notNull(),
    sweptTo: t.hex(),
    sweptAt: t.bigint(),
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
