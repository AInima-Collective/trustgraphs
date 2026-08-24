# Integrate proven outputs

A Trustgraphs network publishes a Merkle root for a program-specific output. Depending on the
program, an entry may be an Ethereum-address score, a funding allocation, an AT Protocol node
score, or another typed result.

Do not infer the meaning of an entry from its byte length or UI label. Resolve the network's
registered program and output domain first, then use the leaf encoding defined for that domain.

## What the proof gives a consumer

For each accepted result, the snapshot stores a root and metadata for the canonical output file.
The proof shows that the guest accepted by the submission-time verifier produced that root from
the checkpointed input commitments and parameters.

This removes the need to trust the prover or indexer for computation. It does not remove reliance
on chain consensus, governance-selected parameters and verifier, SP1 verification soundness, or
source and output availability.

Factory deployments with provenance enabled also record the verifier address, verifier code hash,
program verification key, and parameter hash used for each accepted checkpoint. Use that record
when an integration needs to identify the exact computation behind a historical root.

## Choose an integration path

1. **Verify an address entry onchain.** Use this for contracts consuming an address-keyed output.
2. **Fetch an entry and proof over HTTP.** Use the indexer for discovery and convenience, then
   verify the returned proof against the chain.
3. **Recompute a supported program locally.** Use this when you also want to audit the full
   computation and input reconstruction.

The examples use the [local stack](./quickstart.md), whose indexer API listens at
`http://localhost:65421`.

## 1. Verify an address-keyed entry onchain

### Read the accepted state

`MerkleSnapshot` exposes the latest and historical state views:

```solidity
struct MerkleState {
    uint256 blockNumber;   // input-freeze block, not proof-submission block
    uint256 timestamp;
    bytes32 root;
    bytes32 ipfsHash;      // sha256 digest of the canonical output blob
    string  ipfsHashCid;   // content-addressed identifier for that blob
    uint256 totalValue;
}

function getLatestState() external view returns (MerkleState memory);
function getStateAtBlock(uint256 blockNumber) external view returns (MerkleState memory);
function getStateAtIndex(uint256 index) external view returns (MerkleState memory);
function getStateCount() external view returns (uint256);
function getStates(uint256 offset, uint256 limit) external view returns (MerkleState[] memory);
```

The CID commits to the named bytes; it does not guarantee that a gateway will continue to serve
them. Treat publication and pinning as availability requirements.

These state views are convenient history by freeze block. If more than one accepted update is
filed at the same freeze block, the block-indexed state is replaced. On a provenance-enabled
factory instance, `getAcceptedCheckpoint(checkpointId)` is the checkpoint-exact state and
acceptance record.

### Use the address leaf only for address output domains

Standard trust graph, weighted prior, composition, and contributions payout outputs use the
OpenZeppelin `StandardMerkleTree` address leaf:

```solidity
bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, value))));
```

`account` is an address and `value` is a `uint256` share of `totalValue`. The snapshot provides
helpers for this domain:

```solidity
snapshot.verifyProof(account, value, proof);
snapshot.verifyProofAtBlock(account, value, proof, blockNumber);
snapshot.verifyProofAtStateIndex(account, value, proof, stateIndex);
```

Node-ID programs such as Hypercerts and Nostr use a different output domain and leaf encoding.
Their primary entries must not be passed to the address helpers. A verified EVM binding may add a
separate address-domain entry where the program explicitly supports one.

### Pin the root used by a decision

A proof belongs to one root. If a contract always reads `getLatestState()`, a cached proof becomes
stale as soon as another epoch lands.

Decisions that remain open should pin the root and `totalValue` they started with. The shipped fund
distributor does this for each distribution, and the governance module records the root and total
voting power when a proposal is created.

A Merkle inclusion proof establishes that one leaf is present. It does not prove that an absent
account has no leaf. Programs in this repository produce at most one canonical entry per key, but
an integration should rely on the admitted program and output-domain rules for that uniqueness.

## 2. Fetch entries and proofs from the indexer

The indexer follows contract events, fetches canonical output blobs, rebuilds their trees, and
refuses proof requests when the recomputed root differs from the accepted root. It can still be
unavailable or withhold a response; it cannot make a forged entry pass an independent Merkle
verification.

Resolve a network and its output semantics before decoding entries:

| Route | Purpose |
| --- | --- |
| `/instances` | Paginated registered instance catalog |
| `/instances/:id` | One registered instance and its contract set |
| `/instances/:id/params` | Parameters derived from onchain publication events |
| `/score-programs/:snapshot` | Authenticated program ID, output domain, key encoding, and registry provenance |

Clients should reject missing, unknown, conflicted, or unexpected program/domain bindings. Do not
fall back to guessing from a 20-byte or 32-byte key.

### Address-based roots

| Route | Includes a Merkle proof? | Purpose |
| --- | --- | --- |
| `/merkle/:snapshot/all` | No | Accepted root list |
| `/merkle/:snapshot/:root` | Yes, for every entry | Full address-keyed tree and metadata; `:root` may be `current` |
| `/merkle/:snapshot/:root/:account` | Yes | One `{account, value, proof}` bundle |
| `/network/:snapshot` | No per-entry proof | Member and counted-vouch display data |
| `/network/:snapshot/status` | No | Root freshness and pending-input status |
| `/network/:snapshot/checkpoints/:checkpointId/inputs` | No output proof | Fold-ordered lane-1 vouch inputs for standard or weighted programs |

The common application loop is:

1. request `/merkle/<snapshot>/current/<account>`;
2. read the current onchain state or a root your application already pinned;
3. confirm the bundle names that root; and
4. verify `{account, value, proof}` locally or pass it to the consuming contract.

The `/network` route is for display; its rows are not individual proof bundles. The checkpoint
input route is explicitly lane-1-only and is not sufficient to reconstruct a strict offchain EAS,
Contributions, Hypercerts, Nostr, or composition proof.

### Program-specific routes

Hypercerts list routes return score rows without proofs. Single-node routes such as
`/hypercerts/:snapshot/:root/score/:nodeId` return the node value, root, and Merkle proof. Validate
the node output domain before reconstructing its leaf.

Contributions routes under `/contributions/:snapshot` serve round records, claim-level audit data,
and address payout bundles. Claim scores use a claim-ID domain distinct from the payout root's
address domain. See [Contributions](./contributions.md) before mixing those values.

When the canonical blob cannot be retrieved or validated, proof routes return an availability
error instead of inventing entries from indexed display data.

## 3. Recompute a standard onchain EAS result

The browser library at `packages/frontend/lib/pagerank` mirrors the canonical standard
`trust-graph` core for onchain lane-1 inputs. It uses fixed-point integer arithmetic, canonical
encoding, Merkle construction, and CID construction checked by shared golden vectors.

```ts
import { compute } from '@/lib/pagerank'

const result = compute({ edges, params })
// Compare result.journal.outputRoot with the accepted onchain root.
```

For this specific program:

- fetch fold-ordered lane-1 records from
  `/network/:snapshot/checkpoints/:checkpointId/inputs`;
- reconstruct and compare the accumulator and count with the checkpoint contract;
- obtain the exact checkpoint parameter version and confirm its hash; and
- compare the output root, blob digest, CID, and total value with the accepted result.

This path does not reproduce every Trustgraphs program. A strict offchain EAS checkpoint also
needs the anchor history and envelope witnesses. Weighted prior uses its committed manifest and a
separate personalized recurrence. Contributions, Hypercerts, Nostr, composition, and signer sync
have dedicated cores and witness rules.

For a repository-independent lane-1 walkthrough, see [Reproduce a public EAS
epoch](../verify/reproduce-an-epoch.md).

## Trust assumptions by path

| Path | What you independently check | What still matters |
| --- | --- | --- |
| Onchain Merkle verification | Entry belongs to an accepted root | Chain consensus, accepted verifier/program and parameters, Merkle leaf domain |
| HTTP plus independent proof verification | Same membership check, with easier discovery | Endpoint availability and correct program/domain selection |
| Full local reproduction | Membership, input commitment, and program output | Exact source witness and build availability, plus the chain and governance assumptions above |

See [Networks and programs](../concepts/networks-and-programs.md) for output semantics and [Epochs
and proofs](../concepts/epochs-and-proofs.md) for the acceptance statement.
