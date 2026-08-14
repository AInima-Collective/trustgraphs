import { index, onchainTable, primaryKey } from 'ponder'

/*///////////////////////////////////////////////////////////////
        ERC-8004 IDENTITY — event-sourced enrichment only
//////////////////////////////////////////////////////////////*/

/** Current registry control-plane state, reconstructed from proxy events. */
export const erc8004Registry = onchainTable(
  'erc8004_registry',
  (t) => ({
    id: t.text().primaryKey(), // `eip155:<chainId>:<lowercase proxy>`
    chainId: t.text().notNull(),
    proxy: t.hex().notNull(),
    implementation: t.hex().notNull(),
    version: t.text().notNull(),
    owner: t.hex(),
    sourceBlock: t.bigint().notNull(),
    observedBlock: t.bigint().notNull(),
    observedTimestamp: t.bigint().notNull(),
    observedTxHash: t.hex().notNull(),
  }),
  (t) => ({
    chainProxyIdx: index().on(t.chainId, t.proxy),
    ownerIdx: index().on(t.owner),
    implementationIdx: index().on(t.implementation),
  })
)

/** Append-only implementation and registry-owner history. */
export const erc8004RegistryEvent = onchainTable(
  'erc8004_registry_event',
  (t) => ({
    id: t.text().primaryKey(),
    registryId: t.text().notNull(),
    kind: t.text().notNull(), // `upgrade` | `ownership`
    implementation: t.hex(),
    version: t.text(),
    previousOwner: t.hex(),
    newOwner: t.hex(),
    blockNumber: t.bigint().notNull(),
    transactionIndex: t.integer().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (t) => ({
    registryIdx: index().on(t.registryId),
    orderIdx: index().on(
      t.registryId,
      t.blockNumber,
      t.transactionIndex,
      t.logIndex
    ),
  })
)

/** Current ERC-8004 agent state. IDs are registry-qualified; no address reverse lookup is guessed. */
export const erc8004Agent = onchainTable(
  'erc8004_agent',
  (t) => ({
    id: t.text().primaryKey(), // `agent:eip155:<chainId>:<registry>:<decimal agentId>`
    chainId: t.text().notNull(),
    registry: t.hex().notNull(),
    agentId: t.bigint().notNull(),
    owner: t.hex(),
    agentWallet: t.hex(),
    agentURI: t.text().notNull(),
    registeredBlock: t.bigint().notNull(),
    registeredTimestamp: t.bigint().notNull(),
    registeredTxHash: t.hex().notNull(),
    updatedBlock: t.bigint().notNull(),
    updatedTransactionIndex: t.integer().notNull(),
    updatedLogIndex: t.integer().notNull(),
    updatedTimestamp: t.bigint().notNull(),
    updatedTxHash: t.hex().notNull(),
  }),
  (t) => ({
    registryAgentIdx: index().on(t.chainId, t.registry, t.agentId),
    ownerIdx: index().on(t.owner),
    walletIdx: index().on(t.agentWallet),
  })
)

/** Temporal owner/verified-wallet relation changes in canonical log order. */
export const erc8004AgentRelationHistory = onchainTable(
  'erc8004_agent_relation_history',
  (t) => ({
    id: t.text().primaryKey(),
    agentKey: t.text().notNull(),
    relation: t.text().notNull(), // `owner` | `verified_wallet`
    account: t.hex().notNull(),
    active: t.boolean().notNull(),
    blockNumber: t.bigint().notNull(),
    transactionIndex: t.integer().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (t) => ({
    agentIdx: index().on(t.agentKey),
    accountIdx: index().on(t.account),
    orderIdx: index().on(
      t.agentKey,
      t.blockNumber,
      t.transactionIndex,
      t.logIndex
    ),
  })
)

/** Every on-chain URI pointer version; fetching its document is an asynchronous sidecar concern. */
export const erc8004AgentUriVersion = onchainTable(
  'erc8004_agent_uri_version',
  (t) => ({
    id: t.text().primaryKey(),
    agentKey: t.text().notNull(),
    uri: t.text().notNull(),
    kind: t.text().notNull(), // `registered` | `updated`
    updatedBy: t.hex(),
    blockNumber: t.bigint().notNull(),
    transactionIndex: t.integer().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (t) => ({
    agentIdx: index().on(t.agentKey),
    orderIdx: index().on(
      t.agentKey,
      t.blockNumber,
      t.transactionIndex,
      t.logIndex
    ),
  })
)

/** Full identity event timeline. Values are presentation/audit data, never score inputs. */
export const erc8004AgentEvent = onchainTable(
  'erc8004_agent_event',
  (t) => ({
    id: t.text().primaryKey(),
    agentKey: t.text().notNull(),
    kind: t.text().notNull(), // Registered | URIUpdated | MetadataSet | Transfer
    actor: t.hex(),
    from: t.hex(),
    to: t.hex(),
    uri: t.text(),
    metadataKey: t.text(),
    metadataValue: t.hex(),
    blockNumber: t.bigint().notNull(),
    transactionIndex: t.integer().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (t) => ({
    agentIdx: index().on(t.agentKey),
    orderIdx: index().on(
      t.agentKey,
      t.blockNumber,
      t.transactionIndex,
      t.logIndex
    ),
  })
)

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

/*///////////////////////////////////////////////////////////////
        THE TRUST-GRAPH CATALOG — one row per factory instance
//////////////////////////////////////////////////////////////*/

/**
 * `TrustgraphsFactory.InstanceCreated`, one row per trust-graph network created through the factory
 * (research/INSTANCE_FACTORY.md §3). This table REPLACES `config/networks.json` as the trust-graph
 * catalog: a community that signs one `createInstance` transaction is browsable here seconds later,
 * with no config edit, no redeploy, and no indexer restart. The same event is what Ponder's
 * `factory()` sources key off to discover the instance's snapshot / resolver / distributor, so a
 * row existing here and that instance's events being indexed are the same fact.
 *
 * Everything a network page needs to render is carried here (frontend/lib/types.ts `Network`):
 * addresses under `snapshot`/`resolver`/`distributor`, the vouch schema as `schemaUid` +
 * `schemaString`, the scoring knobs as `params`, and the presentation copy as `metadata` (resolved
 * best-effort from `metadataURI`; presentation-only, never consensus-relevant).
 *
 * `params` is the FULL 17-field struct exactly as emitted, with every uint256/uint64 as a decimal
 * string so the JSON round-trips losslessly. `paramsHash` is recomputed here from those fields with
 * the same TS port the browser recompute uses (frontend/lib/pagerank/encode) — it always equals
 * `MerkleSnapshot(snapshot).paramsHash()`, which is exactly the self-check the multi-instance
 * proving loop performs before proving an instance.
 */
export const instance = onchainTable(
  'instance',
  (t) => ({
    // keccak256(abi.encode(creator, name, salt)) — the registry key.
    id: t.hex().primaryKey(),
    // The factory that minted it, kept for provenance across a factory redeploy.
    factory: t.hex().notNull(),
    // The indexed chain (string, as elsewhere in this schema). `params.chainId` is the chain id
    // hashed into `paramsHash`; the two agree for every instance created on the chain it indexes.
    chainId: t.text().notNull(),
    creator: t.hex().notNull(),
    // Holder of both snapshot roles and the distributor's ownership (creator-as-admin in v1).
    admin: t.hex().notNull(),
    name: t.text().notNull(),
    // IPFS (or http) URI of `{name, description, criteria, image, applicationUrl}`. May be empty.
    metadataURI: t.text().notNull(),
    // The resolved presentation blob, or null when absent/unreachable/not-yet-fetched. Never
    // consensus-relevant, so a failure to fetch it must not (and does not) stall indexing.
    metadata: t.json(),
    // The instance's EASIndexerResolver == its AttestationAccumulator == params.accumulator.
    resolver: t.hex().notNull(),
    schemaUid: t.hex().notNull(),
    // The canonical vouch schema string every factory instance shares.
    schemaString: t.text().notNull(),
    snapshot: t.hex().notNull(),
    // Null when the creator declined a fund distributor (the event carries address(0)).
    distributor: t.hex(),
    // The token the community intends to distribute; presentation only (the distributor is
    // multi-token). Null when unset.
    distributorToken: t.hex(),
    // The EFFECTIVE epoch length in blocks, after the factory's floor was applied.
    epochLength: t.bigint().notNull(),
    paramsHash: t.hex().notNull(),
    params: t.json().notNull(),
    // Null for legacy raw-hash instances. Versioned factory instances discover this from the
    // separate `ParamsControllerCreated` event so the frozen `InstanceCreated` ABI never changes.
    paramsController: t.hex(),
    paramsVersion: t.bigint(),
    paramsExecutedAtBlock: t.bigint(),
    paramsExecutedTimestamp: t.bigint(),
    paramsExecutedTxHash: t.hex(),
    // Null until the first CheckpointParamsPinned event carrying the current version's hash.
    paramsFirstCheckpoint: t.bigint(),
    // Denormalized out of `params` so seed membership is queryable without unpacking the JSON.
    trustedSeeds: t.hex().array().notNull(),
    createdBlock: t.bigint().notNull(),
    createdTimestamp: t.bigint().notNull(),
    createdTxHash: t.hex().notNull(),
  }),
  (t) => ({
    factoryIdx: index().on(t.factory),
    creatorIdx: index().on(t.creator),
    adminIdx: index().on(t.admin),
    snapshotIdx: index().on(t.snapshot),
    resolverIdx: index().on(t.resolver),
    distributorIdx: index().on(t.distributor),
    schemaUidIdx: index().on(t.schemaUid),
    createdBlockIdx: index().on(t.createdBlock),
    createdTimestampIdx: index().on(t.createdTimestamp),
    paramsControllerIdx: index().on(t.paramsController),
  })
)

/*///////////////////////////////////////////////////////////////
       APPEND-ONLY TRUST-GRAPH PARAMETER VERSION HISTORY
//////////////////////////////////////////////////////////////*/

export const parameterVersion = onchainTable(
  'parameter_version',
  (t) => ({
    id: t.text().primaryKey(), // `${instanceId}-${version}`
    instanceId: t.hex().notNull(),
    controller: t.hex().notNull(),
    version: t.bigint().notNull(),
    paramsHash: t.hex().notNull(),
    previousParamsHash: t.hex().notNull(),
    params: t.json().notNull(),
    trustedSeeds: t.hex().array().notNull(),
    evidenceURI: t.text().notNull(),
    executor: t.hex().notNull(),
    executedAtBlock: t.bigint().notNull(),
    executedTimestamp: t.bigint().notNull(),
    executedTxHash: t.hex().notNull(),
    firstCheckpoint: t.bigint(),
    firstCheckpointBlock: t.bigint(),
    firstCheckpointTimestamp: t.bigint(),
    firstCheckpointTxHash: t.hex(),
    // Inconsistent versions remain visible for diagnosis but never replace the instance's current
    // tuple. This prevents one malformed instance from stalling indexing for healthy networks.
    valid: t.boolean().notNull(),
    invalidReason: t.text(),
  }),
  (t) => ({
    instanceIdx: index().on(t.instanceId),
    controllerIdx: index().on(t.controller),
    versionIdx: index().on(t.instanceId, t.version),
    paramsHashIdx: index().on(t.instanceId, t.paramsHash),
    checkpointIdx: index().on(t.instanceId, t.firstCheckpoint),
  })
)

/** Complete, append-only Contributions tuples recovered from their typed controller events. */
export const contributionsParameterVersion = onchainTable(
  'contributions_parameter_version',
  (t) => ({
    id: t.text().primaryKey(),
    instanceId: t.hex().notNull(),
    controller: t.hex().notNull(),
    snapshot: t.hex().notNull(),
    eas: t.hex().notNull(),
    version: t.bigint().notNull(),
    paramsHash: t.hex().notNull(),
    previousParamsHash: t.hex().notNull(),
    params: t.json().notNull(),
    trustedSeeds: t.hex().array().notNull(),
    evidenceURI: t.text().notNull(),
    executor: t.hex().notNull(),
    executedAtBlock: t.bigint().notNull(),
    executedTimestamp: t.bigint().notNull(),
    executedTxHash: t.hex().notNull(),
    valid: t.boolean().notNull(),
    invalidReason: t.text(),
  }),
  (t) => ({
    instanceIdx: index().on(t.instanceId),
    controllerIdx: index().on(t.controller),
    snapshotHashIdx: index().on(t.snapshot, t.paramsHash),
    versionIdx: index().on(t.instanceId, t.version),
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
        WHO PRODUCED A ROOT, AND WHO GETS PAID FOR IT
//////////////////////////////////////////////////////////////*/

// MerkleSnapshot.MerkleProofSubmitted — one row per landed proof.
//
// `prover` and `recipient` are deliberately separate columns. The prover paid the gas; the
// recipient is what the guest committed in the journal and is who the bounty is owed to. They
// differ whenever a root was relayed, and keeping them apart is what lets the UI say "proven by X,
// paid to Y" instead of guessing.
export const proofSubmission = onchainTable(
  'proof_submission',
  (t) => ({
    id: t.text().primaryKey(),
    snapshot: t.hex().notNull(),
    chainId: t.text().notNull(),
    checkpointId: t.bigint().notNull(),
    root: t.hex().notNull(),
    /** `msg.sender` — whoever paid the gas. */
    prover: t.hex().notNull(),
    /** The journal-committed payee. Zero means the root carries no bounty. */
    recipient: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (t) => ({
    snapshotIdx: index().on(t.snapshot),
    checkpointIdx: index().on(t.checkpointId),
    proverIdx: index().on(t.prover),
    recipientIdx: index().on(t.recipient),
    blockNumberIdx: index().on(t.blockNumber),
  })
)

/*///////////////////////////////////////////////////////////////
        WHEN INPUTS FROZE (trigger() → SnapshotTriggered)
//////////////////////////////////////////////////////////////*/

// MerkleSnapshot.SnapshotTriggered — one row per frozen checkpoint. The row's (blockNumber,
// logIndex) is the freeze boundary: an accumulator fold ordered before it is inside the
// checkpoint, one ordered after it belongs to the next. Joined with `proofSubmission` on
// (snapshot, checkpointId) this answers the two questions the app shows between an attestation
// landing and its scores arriving: "is a recount running right now" (a trigger newer than the
// last applied proof) and "how many attestations await the next update" (folds past the applied
// checkpoint's boundary).
export const snapshotTrigger = onchainTable(
  'snapshot_trigger',
  (t) => ({
    id: t.text().primaryKey(),
    snapshot: t.hex().notNull(),
    chainId: t.text().notNull(),
    checkpointId: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (t) => ({
    snapshotIdx: index().on(t.snapshot),
    checkpointIdx: index().on(t.snapshot, t.checkpointId),
  })
)

/*///////////////////////////////////////////////////////////////
            THE PROVING TANK (ProvingVault)
//////////////////////////////////////////////////////////////*/

// One row per instance: the current tank, maintained by folding deposits, claims and withdrawals.
// A running balance rather than a per-event log because the question the UI asks is "how much is
// left and how fast is it going", which a log answers only after a scan.
export const provingVaultAccount = onchainTable(
  'proving_vault_account',
  (t) => ({
    /** `instanceId`. */
    id: t.hex().primaryKey(),
    chainId: t.text().notNull(),
    vault: t.hex().notNull(),
    /** Bound at first deposit and never re-resolved; a registry update cannot move it. */
    snapshot: t.hex().notNull(),
    program: t.hex().notNull(),
    ethBalance: t.bigint().notNull(),
    usdcBalance: t.bigint().notNull(),
    /** Cumulative, so a burn rate is (spent since T) / (T .. now) without walking the log. */
    totalDepositedEth: t.bigint().notNull(),
    totalDepositedUsdc: t.bigint().notNull(),
    totalSpentEth: t.bigint().notNull(),
    totalSpentUsdc: t.bigint().notNull(),
    /** Block of the most recent PAID root, which is what the cadence guard keys on. */
    lastPaidBlock: t.bigint().notNull(),
    /** Non-zero while a withdrawal is in its notice period. */
    withdrawalReadyAt: t.bigint().notNull(),
    updatedAt: t.bigint().notNull(),
  }),
  (t) => ({
    vaultIdx: index().on(t.vault),
    snapshotIdx: index().on(t.snapshot),
  })
)

// Every top-up, so "who funded this community" is answerable and a burn rate has a denominator.
export const provingVaultDeposit = onchainTable(
  'proving_vault_deposit',
  (t) => ({
    id: t.text().primaryKey(),
    instanceId: t.hex().notNull(),
    chainId: t.text().notNull(),
    /** Zero address = ETH. */
    token: t.hex().notNull(),
    from: t.hex().notNull(),
    amount: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (t) => ({
    instanceIdx: index().on(t.instanceId),
    fromIdx: index().on(t.from),
    blockNumberIdx: index().on(t.blockNumber),
  })
)

// Every bounty actually paid, and every one that was not.
//
// `skipped` rows matter as much as paid ones: a root that landed and paid nothing is the signal
// that a tank ran dry or a feed went stale, and without it the UI cannot tell "nobody is proving
// this" from "everybody is proving it for free".
export const provingVaultClaim = onchainTable(
  'proving_vault_claim',
  (t) => ({
    id: t.text().primaryKey(),
    instanceId: t.hex().notNull(),
    chainId: t.text().notNull(),
    checkpointId: t.bigint().notNull(),
    /** Null on a skipped claim. */
    recipient: t.hex(),
    submitter: t.hex(),
    /** USD scaled by 1e8. */
    feeUsd: t.bigint().notNull(),
    gasUsd: t.bigint().notNull(),
    ethSpent: t.bigint().notNull(),
    usdcSpent: t.bigint().notNull(),
    /** True when the root landed but paid nothing; `reason` is `IneligibleReason`. */
    skipped: t.boolean().notNull(),
    reason: t.integer().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (t) => ({
    instanceIdx: index().on(t.instanceId),
    recipientIdx: index().on(t.recipient),
    blockNumberIdx: index().on(t.blockNumber),
  })
)

// Pull-payment credits, per (account, token). The vault pays by credit, so "what am I owed" is a
// balance rather than a sum over events.
export const provingVaultCredit = onchainTable(
  'proving_vault_credit',
  (t) => ({
    /** `${account}-${token}`. */
    id: t.text().primaryKey(),
    chainId: t.text().notNull(),
    account: t.hex().notNull(),
    token: t.hex().notNull(),
    accrued: t.bigint().notNull(),
    withdrawn: t.bigint().notNull(),
    /** `accrued - withdrawn` — what the recipient can pull right now. */
    outstanding: t.bigint().notNull(),
    updatedAt: t.bigint().notNull(),
  }),
  (t) => ({
    accountIdx: index().on(t.account),
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
    count: t.bigint().notNull(), // uint64 — the head's owner-signed monotonic position (H-5)
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

// MerkleSnapshot.AnchorsCheckpointed — the lane-2 accumulator frozen at each snapshot trigger.
// `anchorAcc`/`anchorCount` are what the guest consumes for that epoch (zeros for a lane-1-only
// instance with no AnchorRegistry).
//
// `checkpointId` restarts at 0 for EVERY MerkleSnapshot, so it is unique only when paired with the
// emitting contract (same reasoning as `merkleFundDistribution`'s composite key). A bare
// `checkpointId` pk collides the moment a second instance triggers its first epoch — which, now
// that instances are minted permissionlessly by the factory, is the normal case rather than an
// edge case.
export const anchorCheckpoint = onchainTable(
  'anchor_checkpoint',
  (t) => ({
    checkpointId: t.bigint().notNull(), // uint256
    address: t.hex().notNull(), // MerkleSnapshot that emitted it
    anchorAcc: t.hex().notNull(),
    anchorCount: t.bigint().notNull(), // uint64
    blockTimestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
  }),
  (t) => ({
    pk: primaryKey({ columns: [t.address, t.checkpointId] }),
    addressIdx: index().on(t.address),
    checkpointIdIdx: index().on(t.checkpointId),
    anchorAccIdx: index().on(t.anchorAcc),
    blockNumberIdx: index().on(t.blockNumber),
  })
)

/*///////////////////////////////////////////////////////////////
        CONTRIBUTIONS PROGRAM — fold log + decoded records (M3)
//////////////////////////////////////////////////////////////*/

// The chained-hash accumulator fold log, one row per fold (attest AND revoke), for every
// accumulator-bearing resolver (the trust EASIndexerResolver instances, kinds {0, 1}, and the
// ContributionResolver, kinds 0–5 per docs/build/contributions/interfaces.md §2). This is the indexer's
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

/*///////////////////////////////////////////////////////////////
       OPTIONAL FACTORY SIGNER-SYNC — live state and receipts
//////////////////////////////////////////////////////////////*/

export const signerSyncModule = onchainTable(
  'signer_sync_module',
  (t) => ({
    address: t.hex().primaryKey(),
    instanceId: t.hex().notNull(),
    operatorInstanceId: t.hex().notNull(),
    safe: t.hex().notNull(),
    scoreSnapshot: t.hex().notNull(),
    accumulator: t.hex().notNull(),
    verifier: t.hex().notNull(),
    programVKey: t.hex().notNull(),
    selectionParamsHash: t.hex().notNull(),
    topN: t.integer().notNull(),
    minThreshold: t.integer().notNull(),
    targetThresholdBps: t.integer().notNull(),
    paused: t.boolean().notNull(),
    safeModuleEnabled: t.boolean().notNull(),
    hasAppliedCheckpoint: t.boolean().notNull(),
    lastAppliedCheckpoint: t.bigint(),
    lastSyncedBlock: t.bigint(),
    lastSyncedTimestamp: t.bigint(),
    lastSyncedTxHash: t.hex(),
    createdBlock: t.bigint().notNull(),
    createdTimestamp: t.bigint().notNull(),
    createdTxHash: t.hex().notNull(),
  }),
  (t) => ({
    instanceIdx: index().on(t.instanceId),
    operatorInstanceIdx: index().on(t.operatorInstanceId),
    safeIdx: index().on(t.safe),
    snapshotIdx: index().on(t.scoreSnapshot),
    enabledIdx: index().on(t.safeModuleEnabled),
  })
)

export const signerSyncRotation = onchainTable(
  'signer_sync_rotation',
  (t) => ({
    id: t.text().primaryKey(),
    module: t.hex().notNull(),
    instanceId: t.hex().notNull(),
    checkpointId: t.bigint().notNull(),
    signerSetRoot: t.hex().notNull(),
    threshold: t.bigint().notNull(),
    submitter: t.hex().notNull(),
    signers: t.hex().array().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (t) => ({
    moduleIdx: index().on(t.module),
    instanceIdx: index().on(t.instanceId),
    checkpointIdx: index().on(t.module, t.checkpointId),
    blockIdx: index().on(t.blockNumber),
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
    // distributionIndex — restarts at 0 for EACH distributor contract, so it is UNIQUE only when
    // paired with `merkleFundDistributor` (see the composite primaryKey below). A bare `id` pk
    // collides across programs' distributors (trust-graph / contributions / hypercerts each fund
    // their own).
    id: t.bigint().notNull(),
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
    pk: primaryKey({ columns: [t.merkleFundDistributor, t.id] }),
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
