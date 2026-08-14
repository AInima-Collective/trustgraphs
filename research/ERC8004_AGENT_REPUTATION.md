# ERC-8004 agent identity and reputation spike

**Status:** research complete; recommended thin slice defined

**Date:** 2026-08-12

**Scope:** ERC-8004 identity enrichment, agent views over existing trust graphs, and a possible
agent-reputation program. This document does not change any contract, score, or proof claim.

## Outcome

The relevant proposal is **ERC-8004, Trustless Agents**, not ERC-8003. ERC-8004 is still a Draft
ERC, although the reference Identity and Reputation registries are deployed on Optimism and many
other EVM chains. ERC-8003 is an unrelated, non-canonical ERC-20 sentinel-storage proposal.

Trustgraphs should explore ERC-8004 in two deliberately separate layers:

1. **Ship an identity enrichment layer and an agents-only lens over existing trust graphs.** Mark
   an address as the current verified wallet for one or more agents, separately show agent NFT
   ownership, render agent metadata, and filter the existing vouch graph to agent-associated
   accounts. This is useful, relatively small, and does not alter trustgraphs' proven scores.
2. **Prototype an explicitly experimental agent-to-agent reputation graph.** Index raw ERC-8004
   feedback, map a reviewer address to an agent only when the mapping is unambiguous at the
   feedback block, and apply a narrow, published scoring policy. Do not call this output
   ZK-proven or canonical until external-registry input completeness is solved.

The Validation Registry should remain behind an experimental flag. The draft specifies it, but
the reference repository warns that it remains under active design and the official deployment
list currently publishes only Identity and Reputation addresses.

The most important product rule is:

> An ERC-8004 agent is not an address. An agent is a durable registry-qualified token identity;
> ownership, verified wallet, and advertised endpoints are mutable relationships to that identity.

## What ERC-8004 provides

ERC-8004 defines three per-chain registry interfaces:

| Registry | Canonical subject | What it records | What it does not establish |
| --- | --- | --- | --- |
| Identity | ERC-721 `agentId` within an Identity Registry | Owner, mutable `agentURI`, arbitrary metadata, signature-verified `agentWallet` | That advertised services work, are safe, or are actually autonomous |
| Reputation | The Identity Registry's `agentId` | Signed fixed-point feedback, free-form tags, revocation, response pointers | That feedback follows an interaction, is truthful, or comes from a unique reviewer |
| Validation | `agentId` plus a requested validator | Requests and validator responses from 0 to 100 | Validator quality, independence, stake, incentives, or slashing |

The globally qualified identity in the standard is:

```text
agentRegistry = eip155:<chainId>:<identityRegistry>
agentId       = <ERC-721 tokenId>
```

Trustgraphs should use the following canonical application key and never a bare token ID:

```text
agent:eip155:<chainId>:<lowercase identityRegistry>:<decimal agentId>
```

If a program needs a 32-byte node ID, use `keccak256(utf8(canonicalAgentKey))` and lock the exact
string construction in golden vectors. This follows the existing Hypercerts precedent of hashing
a durable non-address identity into a node ID.

### Identity Registry

The Identity Registry is ERC-721 plus:

```solidity
register()
register(string agentURI)
register(string agentURI, MetadataEntry[] metadata)
setAgentURI(uint256 agentId, string newURI)
getMetadata(uint256 agentId, string key)
setMetadata(uint256 agentId, string key, bytes value)
getAgentWallet(uint256 agentId)
setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)
unsetAgentWallet(uint256 agentId)
```

Its relevant events are standard ERC-721 `Transfer` plus `Registered`, `URIUpdated`, and
`MetadataSet`. The reserved `agentWallet` starts as the registering owner. Changing it requires an
EIP-712 signature from an EOA or ERC-1271 validation by a contract wallet. It is cleared when the
agent NFT transfers.

The registration file may be an IPFS URI, HTTPS URI, or base64 `data:` URI. Its v1 shape includes
NFT presentation fields, an `active` flag, services such as MCP/A2A/OASF/web/ENS/DID, optional
`supportedTrust`, and a `registrations` array that links the document back to its on-chain
identities. An HTTPS service can optionally publish a reciprocal
`/.well-known/agent-registration.json` file to demonstrate domain association.

These fields remain self-assertions. A reciprocal file can support “domain associated with this
identity”; neither it nor the NFT supports “service works” or “agent is safe.”

### Reputation Registry

Any address other than the target agent's current owner or approved operator can call:

```solidity
giveFeedback(
  uint256 agentId,
  int128 value,
  uint8 valueDecimals,
  string tag1,
  string tag2,
  string endpoint,
  string feedbackURI,
  bytes32 feedbackHash
)
```

`valueDecimals` is 0–18. Values are deliberately heterogeneous: the specification's examples
include ratings, reachability, uptime, latency, revenues, and yield. `tag1` and `tag2` are free-form.
It is therefore invalid to average or rank all feedback as though it were one reputation scale.

Feedback is numbered from 1 per `(agentId, clientAddress)`. The client can revoke its entry, and
any address can append a response pointer. The `endpoint`, `feedbackURI`, and `feedbackHash` live
in events but not contract storage, so durable consumers need an event index.

The registry's `getSummary` requires a non-empty reviewer address list specifically to limit
Sybil/spam exposure. This is a useful confirmation of trustgraphs' opportunity: the ERC is a
standard signal transport, while reviewer selection and graph-aware aggregation are intentionally
left to consumers.

### Deployment and maturity

As of this spike:

- ERC-8004 remains **Draft**.
- The team-curated registry repository lists Identity and Reputation proxies across many mainnets
  and testnets, including Optimism.
- Listed mainnets generally use Identity
  `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` and Reputation
  `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`. Listed testnets generally use Identity
  `0x8004A818BFB912233c491871b3d84c89A494BD9e` and Reputation
  `0x8004B663056A597Dffe9eCcC1965A193B7388713`.
- Those deployments are owner-controlled UUPS proxies. ABI version, proxy implementation,
  `getVersion()`, `Upgraded`, and ownership changes are part of the integration's trust boundary.
- The repository does not list a deployed Validation Registry and explicitly warns that its design
  is still moving.

Registry addresses must be allowlisted per chain. An arbitrary contract can mimic the interface,
and the same deterministic-looking address is not evidence that code is deployed on a chain.

### Early ecosystem evidence

Registration count is not a useful proxy for operational agents or trustworthy reputation. A June
2026 empirical preprint crawled Identity and Reputation events plus linked files on Ethereum, BSC,
and Base through 2026-05-13. It found that only 3%, 4%, and 15% of registrations on those chains,
respectively, exposed a valid ERC-8004 registration file with at least one live service endpoint.
It also reported heavy coordinated reviewer behavior and showed that feedback units were often not
commensurable. The paper is an early preprint rather than a protocol authority, but its observations
directly support relation-specific badges, coverage metrics, and graph-weighted reviewers instead
of a raw global average.

Another Ethereum-only study of the first 10,000 agent IDs describes the same early ecosystem as
“registration-heavy but operationally shallow,” with ownership, service exposure, and feedback
concentrated among a small fraction of identities. These are snapshots of a fast-moving ecosystem,
not permanent adoption forecasts.

Sources:

- [Can Trustless Agents Be Trusted?](https://arxiv.org/abs/2606.26028)
- [From Agent Identity to Agent Economy](https://arxiv.org/abs/2606.12128)

### Build versus consume

| Path | Good for | Constraint | Recommendation |
| --- | --- | --- | --- |
| Index allowlisted registries in Ponder | Canonical events, exact provenance, Optimism support, historical bindings | Requires new tables, handlers, reorg-safe replay, and a safe metadata fetcher | Durable trustgraphs path |
| Agent0 subgraphs | Fast search and parsed metadata on its supported chains | External Graph API/key and indexing policy; documented mainnet set does not include Optimism | Comparison/backfill for the spike, not canonical state |
| Direct RPC getters | Bounded spot verification | No address-to-agent reverse lookup or NFT enumeration; large feedback getters can be impractical | Verification only, not discovery |
| Explorer/vendor APIs | Very fast disposable UI prototype | Vendor availability, coverage, schema, and composite-score semantics | Optional prototype adapter behind the same internal types |

The Graph documents the open-source Agent0 subgraphs as indexing registrations, parsed metadata,
feedback, validations, and aggregates. They are valuable prior art for schema and queries. For the
Trustgraphs product, self-indexed registry events should remain authoritative so a hosted parser or
score cannot silently become part of the proof story.

## “Is this account an agent?”

There is no canonical `isAgent(address)` call and no universal reverse lookup.

`balanceOf(account) > 0` only means the account owns at least one agent NFT. The reference contract
is not ERC721Enumerable, so it does not enumerate those IDs. `getAgentWallet(agentId) == account`
is a stronger operational/payment-wallet relation, but the contract has no wallet-to-agent reverse
mapping. Both questions require event indexing.

Trustgraphs should expose relations rather than one `isAgent` boolean:

| UI state | Evidence | Meaning |
| --- | --- | --- |
| **Verified agent wallet for N agents** | Current on-chain `agentWallet` binding | Strongest account-to-agent association in ERC-8004 |
| **Owns N agent identities** | Current ERC-721 ownership | Controls the identity NFT; may not operate or receive payments for the agent |
| **Approved operator** | Current ERC-721 approval | May manage the NFT; not evidence that the account is the agent |
| **Advertised wallet/service** | Mutable registration file only | Self-asserted presentation data |
| **Active service, checked at …** | Valid registration document plus recent endpoint check | Availability observation, not identity or safety proof |

One account can own or serve as the wallet for several agents. Several agents can share one wallet.
The same agent can have registrations on several chains, with no canonical cross-chain merge
mechanism beyond mutable registration-file backreferences. All APIs and UI therefore need arrays
of qualified `AgentRef`s and provenance, not a boolean or nullable token ID.

Relationships must also be block-aware. On transfer, the reference implementation emits the
wallet-clearing `MetadataSet` before `Transfer`; replay must follow `(blockNumber,
transactionIndex, logIndex)`. A feedback event can be attributed to an agent reviewer only using
the wallet bindings that existed at that event's block, not today's bindings.

## Graph models

There are two useful graphs, with different nodes and claims.

### 1. Agent lens over an existing trustgraph

This is an induced view of the already-proven address graph:

```text
existing EAS vouches + existing proven address scores
                         |
                         v
address ---- current verified-wallet relation ----> ERC-8004 agent identity
                         |
                         v
          badge · metadata · filter · graph styling
```

Nodes and edges remain addresses and EAS vouches. “Agents only” means addresses having at least one
current verified-wallet relation; the score is still that address's existing trustgraphs score.
If a wallet represents multiple agents, the graph keeps one address node and its inspector lists
all associated identities. This avoids pretending that an address-level vouch names one particular
agent.

This phase can accurately say:

- “This address is the verified wallet for these ERC-8004 agents.”
- “This is the vouch subgraph induced by verified agent wallets.”
- “Node size is the existing, proven trustgraphs score.”

It must not say that the ERC-8004 feedback graph was proven or that every associated service is
functional.

### 2. ERC-8004 reputation graph

This is a new typed graph:

```text
Account --OWNS--------------------> Agent
Agent   --USES_VERIFIED_WALLET----> Account
Agent   --ADVERTISES--------------> Service
Account --GAVE_FEEDBACK-----------> Agent
Agent   --REVIEWED----------------> Agent   (derived, sometimes ambiguous)
Account --VALIDATED---------------> Agent   (later, separate signal layer)
```

The source of an on-chain feedback event is always an account. Derive an agent-to-agent edge only
if that account was the verified wallet of exactly one agent at the feedback block. If it matched
zero agents, retain an account-to-agent edge. If it matched more than one, retain the account edge
and mark agent attribution ambiguous; never fan it out as several factual reviews.

Ownership, wallet bindings, URI versions, endpoint observations, feedback, revocations, and
responses all need provenance and temporal validity. They should not be collapsed into one
homogeneous edge set.

## A deliberately narrow reputation experiment

The first scoring experiment should be reproducible and intentionally less general than the ERC.
Define one immutable policy document per run containing:

```text
identityRegistry
reputationRegistry
chainId
startBlock / checkpointBlock
accepted (tag1, tag2, unit, min, max) descriptors
reviewer attribution rule
reviewer seed or upstream score root
pair reconciliation rule
recency rule
negative-signal rule
algorithm parameters
```

Recommended v0 semantics:

1. Select one understood feedback descriptor; do not mix uptime, latency, dollars, ratings, and
   free-form tags. A trustgraphs-specific tag profile can be proposed for new feedback, while public
   experiments can separately analyze established tags such as `starred` or `successRate`.
2. Normalize `value / 10^valueDecimals` into that descriptor's declared range. Reject, rather than
   guess at, values outside the configured semantics.
3. Reconcile to the latest active entry per `(reviewer account, target agent, tag1, tag2)` inside
   the checkpoint. Revocation removes it. This prevents one account from gaining weight by posting
   the same opinion repeatedly.
4. Produce agent-to-agent PageRank edges only for unambiguous historical wallet attribution.
   Preserve every excluded input with a reason code for auditability.
5. Feed only non-negative endorsement weights into the current PageRank family. Negative feedback
   becomes a separate risk/incident signal until a signed graph algorithm is specified and tested;
   silently clipping negatives inside an alleged unified score would be misleading.
6. Weight or filter reviewers through an explicit trusted seed set or a pinned upstream trustgraph
   root. A moving “latest score” is not reproducible.
7. Publish coverage next to score: accepted feedback count, unique reviewers, excluded/ambiguous
   count, last activity, transfer since feedback, and confidence. A sparse score without coverage
   is not useful reputation.

An interesting composition is:

```text
proven trustgraphs reviewer root at block B
                 +
ERC-8004 feedback through checkpoint C
                 |
                 v
       reviewer-weighted agent reputation
```

If this becomes a proved program, both `B` and `C` and the exact mapping/scoring policy must be
journal-bound. This is the promising research direction: ERC-8004 supplies public interoperable
signals; trustgraphs supplies resistance to reviewer Sybil rings and a verifiable aggregation
policy.

### Transfer semantics are a product decision

ERC-8004 reputation targets the transferable agent NFT. Feedback therefore follows the agent
identity after ownership changes, while its verified wallet is cleared. That can represent a
legitimate sale of the agent, but it can also sell accumulated reputation.

The first UI should show transfers and “feedback predates current ownership” explicitly. The
scoring experiment should report pre/post-transfer coverage separately. It should not silently
erase history or silently imply operator continuity. A later network policy can choose whether to
decay pre-transfer feedback or require continuity evidence such as rebinding the same wallet and
reciprocal service domain.

## Proposed trustgraphs integration

### Phase 1 — identity enrichment and agent lens

Start with the official registry on trustgraphs' application chain (Optimism), plus a local test
fixture. Keep the qualified identity model so adding Ethereum/Base or other configured chains does
not require a migration.

Index these Identity events:

- `Registered`, `URIUpdated`, `MetadataSet`, and ERC-721 `Transfer`;
- `Upgraded` and `OwnershipTransferred` for registry provenance;
- optionally ERC-721 approvals if the product actually displays operators.

Use event history as the enumeration source. The reference IDs currently start at zero and there
is no `totalSupply`, next-ID getter, or enumeration extension. Spot-check state with `ownerOf`,
`getAgentWallet`, and `tokenURI` at the indexed block. Do not interpret blank `getAgentWallet` or
generic metadata until agent existence is established.

Suggested Ponder state:

```text
erc8004_agent
  id (canonical qualified key), chainId, registry, agentId
  owner, agentWallet?, agentURI, registeredBlock, updatedBlock

erc8004_agent_relation_history
  eventId, agentKey, relation (owner | verified_wallet | operator)
  account, active, blockNumber, transactionIndex, logIndex, txHash

erc8004_agent_uri_version
  eventId, agentKey, uri, blockNumber, logIndex, txHash

erc8004_registration_document          # availability/presentation, not consensus
  agentKey, uri, contentHash, schemaVersion, parsedJson
  fetchedAt, fetchStatus, error?, endpointChecks?
```

Metadata fetching should be an asynchronous availability sidecar rather than a chain handler that
can stall all indexing. Allow only supported URI schemes; enforce redirect, timeout, byte, and
content-type limits; block private/link-local addresses; validate the registration backreference;
sanitize every rendered string and URL; and retain the fetched content hash. HTTPS content can
change without an on-chain event, whereas IPFS/data URIs have stronger content stability.

Suggested read API:

```text
GET /erc8004/accounts/:address
  -> { verifiedWalletFor: AgentSummary[], owns: AgentSummary[] }

GET /erc8004/agents/:namespace/:chainId/:registry/:agentId
  -> current identity, provenance, registration document, endpoint observations

GET /network/:snapshot
  -> include compact agent relations on each existing account row
```

Joining compact relations into the network response avoids one request per graph node. UI work
then lands at the existing seams:

- account header: relation badges and agent cards;
- network table: Agent column and `all / agent wallets` filter;
- graph: a ring/glyph for verified agent wallets and associated identities in the inspector;
- agents-only lens: induce the current graph on matching address nodes;
- a separate `/agents/...` route for the durable agent identity, never an overloaded account route.

No Rust, guest, contract, Merkle, or score changes are needed in this phase.

### Phase 2 — raw feedback explorer and experimental graph

The raw explorer portion shipped in issue #58; see
[`ERC8004_REPUTATION_EXPLORER.md`](./ERC8004_REPUTATION_EXPLORER.md). The experimental graph and
reviewer-policy work remain separately scoped in #59 and must consume this raw stream without
changing its provenance semantics.

Index `NewFeedback`, `FeedbackRevoked`, and `ResponseAppended` from the configured Reputation
Registry. Keep the full event payload because endpoint/URI/hash are not in storage. Bind the
Reputation Registry to its Identity Registry using `getIdentityRegistry()` and configuration.

Suggested state:

```text
erc8004_feedback
  id = registry + agentId + clientAddress + feedbackIndex
  targetAgentKey, clientAddress, value, valueDecimals, tag1, tag2
  endpoint, feedbackURI, feedbackHash, revoked
  blockNumber, transactionIndex, logIndex, txHash

erc8004_feedback_response
  eventId, feedbackId, responder, responseURI, responseHash
  blockNumber, transactionIndex, logIndex, txHash
```

Do not use `readAllFeedback` as the primary ingestion path; its loops can become impractical.
Event-source the history and use getters only for bounded verification. Likewise, do not label a
response “agent response” merely because it references an agent—anyone may append one.

The first frontend can expose raw feedback grouped by descriptor and reviewer, then render the v0
agent graph with its policy and exclusion audit visible. It must be labelled indexer-computed and
experimental.

### Phase 3 — proved agent-reputation program

Trustgraphs' multi-program layout is already a good fit:

- the PageRank core is generic over the node key;
- Hypercerts already demonstrates durable `bytes32` nodes and optional address-bound leaves;
- the SP1 verifier and journal envelope are program-oriented.

A new program would still require its own canonical core, guest, prover commands, params codec,
golden vectors, browser parity tier, docs, score storage, and program-aware routing. Two current
assumptions must be removed:

1. `MerkleSnapshot`'s consumer proof API is address-keyed. An agent tree needs a node-ID proof API
   or deliberately emitted dual leaves.
2. The indexer currently infers a program from score-key length: 32-byte keys route to Hypercerts.
   An ERC-8004 node ID is also 32 bytes, so ingestion must dispatch from instance program metadata.

The gating issue is **input completeness**. Existing trustgraphs proofs cannot omit or invent EAS
vouches because its resolver maintains the accumulator that is frozen at a checkpoint. The
external ERC-8004 Reputation Registry exposes logs and storage but no trustgraphs-compatible
accumulator. Replaying a Ponder result inside SP1 would prove a calculation over a supplied list,
not that the list contains every canonical feedback event.

Credible paths are:

- a trustgraphs wrapper/mirror with an accumulator, proving only feedback routed through it;
- receipt/storage proofs against a checkpointed canonical block/state root, verified in-guest;
- a canonical-registry change that exposes a checkpointable accumulator;
- or an explicit trusted/committee availability anchor, with the weaker trust claim stated.

Anchoring an exporter-produced list with the existing lane-2 machinery proves consistency with
that anchor, but by itself does not prove completeness relative to an external chain contract.
Until one of the first three paths is designed, the agent graph is not a canonical ZK-proven
Trustgraphs program.

### Phase 4 — validation and composed trust

Add Validation Registry data only after a deployed ABI and semantics stabilize. Keep validators as
their own scored/curated identities. The target agent chooses the validator and the standard does
not provide validator stake or independence, so an unfiltered average validation response is not
a trust score.

## Repository fit and known seams

The current code already has most of the presentation and program structure needed:

- `frontend/lib/types.ts` distinguishes address-keyed trustgraphs instances from node-ID-keyed
  Hypercerts instances, but `NetworkEntry` and `NetworkGraphNode` are currently address-specific.
- `frontend/contexts/NetworkContext.tsx` is the right owner for bulk enrichment, just as it owns
  bounded graph-wide ENS resolution.
- `frontend/app/networks/[id]/component.tsx` owns member columns and filters.
- `frontend/components/NetworkGraph.tsx` builds address nodes, address routes, and its inspector.
- `frontend/app/account/[address]/component.tsx` owns the account header.
- `indexer/src/eas.ts` and `indexer/src/api/network.ts` demonstrate event ingestion and the bulk
  network response.
- `packages/pagerank-core/src/pagerank.rs` already implements generic-key PageRank.
- `packages/hypercerts-core` and the Hypercerts score path demonstrate node-ID outputs and binding
  durable identities back to addresses.

The larger program path also exposes existing platform debt: runtime program discovery is split
between the generic `InstanceRegistry`, a trustgraphs-specific factory catalog, and static lists for
other programs. An ERC-8004 program should use program metadata for routing rather than add another
key-shape or static-list special case.

## Security and privacy notes

- Anyone other than the current owner/operator may review an agent. There is no proof of task,
  payment, uniqueness, or truth; Sybil rings and collusion are expected inputs.
- Self-feedback prevention is narrow and ownership is transferable. Old owners can become eligible
  reviewers after transfer, while the token keeps its feedback.
- Free-form tags and signed values are not mutually comparable without a pinned schema.
- Registration documents, images, service endpoints, feedback files, and response files are
  hostile input. Fetching them creates SSRF, oversized-response, redirect, parser, XSS, and tracking
  risk.
- On-chain event fields, URI pointers, and hashes are permanent. Revocation does not erase logs or
  fetched data. Do not encourage private prompts, task transcripts, PII, or low-entropy secrets in
  feedback payloads; a hash proves integrity, not confidentiality or truth.
- Reference contracts are upgradeable. A version or implementation change can alter interpretation
  without changing the proxy address.
- Endpoint reachability should be timestamped and shown as an observation, never a permanent
  “verified” property.

## Acceptance criteria for the thin slice

The identity-enrichment spike is successful when:

1. A local fixture registers two agents, assigns/transfers/unsets wallets, and the indexer derives
   the correct current and historical relations in log order.
2. `GET /erc8004/accounts/:address` distinguishes verified-wallet and owner relations and returns
   multiple agents without collapsing them.
3. A network response attaches compact agent relations without N+1 reads.
4. Account, member table, and graph inspector display the same evidence labels.
5. The graph can filter to verified agent wallets while every node retains its existing proven
   address score.
6. Invalid, oversized, unavailable, mutable, or backreference-mismatched registration documents
   cannot stall indexing and render only explicit degraded states.
7. Registry address, proxy implementation/version, chain, source block, and metadata fetch time are
   visible in provenance or diagnostics.
8. Existing golden vectors, roots, and proof paths remain byte-identical.

## Decision points before implementation

1. **First chain:** Optimism is the smallest fit with the current production indexer. If the
   product question is cross-chain discovery rather than trustgraphs enrichment, add selected
   Ethereum/Base sources or use a hosted index only as a temporary comparison layer.
2. **Relationship label:** use “verified agent wallet,” not the ambiguous “agent account.”
3. **Agent lens membership:** include only current verified wallets by default; offer NFT ownership
   as a separate filter.
4. **Metadata availability:** decide whether trustgraphs operates its own safe fetch sidecar or
   initially consumes a hosted parsed index while chain events remain canonical.
5. **Feedback descriptor:** choose one exact tag/unit profile before computing any score.
6. **Reviewer trust:** choose a curated seed set or a specific pinned trustgraph root.
7. **Completeness path:** choose mirror, chain proofs, registry cooperation, or explicitly
   indexer-computed status before starting a guest program.

## Sources

Primary sources were checked on 2026-08-12 and pinned here where possible:

- [ERC-8004 canonical specification](https://eips.ethereum.org/EIPS/eip-8004) and
  [spec source at `5c28fbf`](https://github.com/ethereum/ERCs/blob/5c28fbf811a2e96016b17750e87780d4aa812142/ERCS/erc-8004.md)
- [The unrelated ERC-8003 sentinel-storage discussion](https://ethereum-magicians.org/t/erc-8003-erc-20-pre-initialization-extension-sentinel-storage/24993)
- [ERC-8004 reference contracts and deployment list at `68fc676`](https://github.com/erc-8004/erc-8004-contracts/tree/68fc6765761a10fb26f0692df21c8a6f9d12b1be)
- [Identity Registry implementation](https://github.com/erc-8004/erc-8004-contracts/blob/68fc6765761a10fb26f0692df21c8a6f9d12b1be/contracts/IdentityRegistryUpgradeable.sol)
- [Reputation Registry implementation](https://github.com/erc-8004/erc-8004-contracts/blob/68fc6765761a10fb26f0692df21c8a6f9d12b1be/contracts/ReputationRegistryUpgradeable.sol)
- [Validation Registry implementation](https://github.com/erc-8004/erc-8004-contracts/blob/68fc6765761a10fb26f0692df21c8a6f9d12b1be/contracts/ValidationRegistryUpgradeable.sol)
- [Reference deployment upgrade model](https://github.com/erc-8004/erc-8004-contracts/blob/68fc6765761a10fb26f0692df21c8a6f9d12b1be/UPGRADEABLE_IMPLEMENTATION.md)
- [Agent0 ERC-8004 subgraphs documented by The Graph](https://thegraph.com/docs/en/subgraphs/existing-subgraphs/agent0/) — useful for a hosted comparison/backfill, not the canonical trustgraphs data source
