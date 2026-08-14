# Integrate scores

You have an app or a contract, and you want to consume a network's proven trust scores: gate a
feature, weight a vote, split a payout, rank a list. This page is the integrator's map.

The ground truth is small and on-chain. Each network (an *instance* of a scoring *program*; see
[`../concepts/networks-and-programs.md`](../concepts/networks-and-programs.md)) has one
`MerkleSnapshot` contract. The only way a score root gets written there is `submitProof`, which
verifies an SP1 zero-knowledge proof that the root is the correct fixed-point PageRank over the
network's chain-pinned vouch inputs. So a consumer never trusts a server, an operator, or this
project's own indexer: everything below either *is* the chain or is checkable against it.

Nothing is live in production yet; Ethereum mainnet is the target. All examples below run against
the local stack ([`./quickstart.md`](./quickstart.md)), where the indexer serves
`http://localhost:65421`.

Three consumption paths, strongest first:

1. **On-chain, via merkle proof**: for contracts. Trustless.
2. **HTTP, via the indexer**: for apps. Convenience, not truth: every bundle carries the proof and
   root so you can verify it against the chain.
3. **In-browser recompute**: for apps that want to check the math itself, not just the membership
   proof.

## 1. On-chain: verify a `{account, score}` leaf against the proven root

### What the snapshot exposes

`MerkleSnapshot` (`src/contracts/merkle/MerkleSnapshot.sol`) keeps the full history of proven
states:

```solidity
struct MerkleState {
    uint256 blockNumber;   // the block the checkpoint's INPUTS froze at (not the submission block)
    uint256 timestamp;
    bytes32 root;          // the proven {account => score} merkle root
    bytes32 ipfsHash;      // sha256 digest of the canonical score blob
    string  ipfsHashCid;   // the CID the full score set is fetchable by
    uint256 totalValue;    // the summed score points across all accounts
}

function getLatestState() external view returns (MerkleState memory);   // reverts NoMerkleStates before the first root
function getStateAtBlock(uint256 blockNumber) external view returns (MerkleState memory);
function getStateAtIndex(uint256 index) external view returns (MerkleState memory);
function getStateCount() external view returns (uint256);
function getStates(uint256 offset, uint256 limit) external view returns (MerkleState[] memory);
```

States are filed at the checkpoint's input-freeze block, deliberately: "score as of block N" stays
honest even though proving is permissionless, delayed, and racy.

### The leaf encoding

Every consumer in this repo uses the same leaf, the OpenZeppelin `StandardMerkleTree` convention
(double keccak over the ABI-encoded tuple, commutative sorted-pair hashing up the tree):

```solidity
bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, score))));
```

`account` is an `address`, `score` is a `uint256` count of points out of `totalValue`. This exact
line appears in `MerkleSnapshot._verifyProof`, `MerkleFundDistributor.claim`, and
`MerkleGovModule._castVote`; the zk guest and the TS port build the tree the same way, which is why
one proof works everywhere.

The snapshot also exposes ready-made verifier views, so the cheapest integration is a single
external call:

```solidity
snapshot.verifyProof(account, score, proof);                    // against the latest root
snapshot.verifyProofAtBlock(account, score, proof, blockNum);   // against a historical root
snapshot.verifyProofAtStateIndex(account, score, proof, idx);
// plus verifyMyProof / verifyMyProofAtBlock / verifyMyProofAtStateIndex for msg.sender
```

### A consuming contract, sketched

This is the same pattern `MerkleFundDistributor` uses (verify the leaf, then treat
`score / totalValue` as the account's share):

```solidity
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";

contract ScoreGate {
    IMerkleSnapshot public immutable SNAPSHOT;
    uint256 public immutable MIN_SCORE;

    error NotProven();
    error ScoreTooLow();

    constructor(IMerkleSnapshot snapshot, uint256 minScore) {
        SNAPSHOT = snapshot;
        MIN_SCORE = minScore;
    }

    /// Gate on a proven score. The caller supplies the score and its merkle proof
    /// (fetched from the indexer, or rebuilt from the IPFS blob).
    function requireScore(address account, uint256 score, bytes32[] calldata proof) public view {
        IMerkleSnapshot.MerkleState memory state = SNAPSHOT.getLatestState();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, score))));
        if (!MerkleProof.verifyCalldata(proof, state.root, leaf)) revert NotProven();
        if (score < MIN_SCORE) revert ScoreTooLow();
    }

    /// Or weight by share of the pool, exactly as the fund distributor does:
    ///   share = amount * score / state.totalValue
    function shareOf(uint256 amount, uint256 score, IMerkleSnapshot.MerkleState memory state)
        internal
        pure
        returns (uint256)
    {
        return Math.mulDiv(amount, score, state.totalValue);
    }
}
```

Things the shipped consumers got right that yours should too:

- **Pin the root you priced against.** A distribution created at root R must not pay out against a
  later root. `MerkleFundDistributor` copies `root` and `totalMerkleValue` into the distribution at
  creation time (and its `distribute(token, amount, expectedRoot)` takes an `expectedRoot` so the
  transaction reverts if a new root landed in flight). `MerkleGovModule` snapshots the root and
  total voting power per proposal at creation.
- **Absence is not provable with this scheme.** A merkle proof shows an `{account, score}` pair is
  in the tree; it cannot show an account is absent or that a submitted score is the account's only
  leaf. The tree contains one leaf per scored account, so this is fine for "prove you have at least
  X": an attacker cannot forge a higher leaf, and proving a lower one only hurts them.
- **A score is a claim about one root.** If you accept proofs against `getLatestState()`, a user's
  cached proof goes stale when a new epoch lands. Either accept `verifyProofAtBlock` for a window,
  or have the app re-fetch proofs after each root (the indexer makes that cheap; see below).

Existing on-chain consumers to crib from:

- `MerkleFundDistributor.claim(distributionIndex, account, value, proof)` — proportional payouts;
  open claim (anyone can relay, funds always go to `account`).
- `MerkleGovModule.castVote(proposalId, voteType, votingPower, proof)` — score-weighted Safe
  governance; same leaf, root snapshotted per proposal.

## 2. HTTP: the indexer's score and proof routes

The Ponder indexer (`indexer/`) watches the chain, fetches each root's canonical score blob from
IPFS by the CID committed in the proof, and serves scores *with their proofs*. It is a convenience,
never a second source of truth: **every bundle carries the proof and the root, so a consumer can
verify against the chain and ignore the endpoint's honesty entirely.** The indexer holds itself to
the same rule: it rebuilds each tree with the guest-identical merkle code and refuses to serve
entries whose recomputed root does not match the on-chain root (`indexer/src/merkle.ts`).

All routes are GET. `:snapshot` is the network's `MerkleSnapshot` address, the stable handle a
consumer should key on (find it via `/instances` or the `InstanceCreated` event).

Every score response also carries `scoreProgram`: the bytes32 program id and output-domain id,
their stable names/key encoding, the instance/verifier/params tuple, and the exact configured
`InstanceRegistry` event (registry, block, log index, transaction) that authenticated the binding.
Clients must validate the id/domain pair before interpreting a key. `GET
/score-programs/:snapshot` exposes the current binding even before the first root. A missing,
unknown, conflicted, or wrong-namespace binding is `409`; there is no fallback based on whether a
key is 20 or 32 bytes.

Routes keyed by a secondary subject also carry `scoreKeyDomain`; Contributions claim-score and
audit responses use `contributions-claim-v1`, distinct from the program's address-keyed payout
domain.

### Discovery

| Route | Serves |
| --- | --- |
| `/instances` | the factory catalog, paginated (`?limit=&offset=`), filterable by `creator`, `admin`, `snapshot`, `resolver`, `distributor`, `schemaUid`; each row includes the instance's contract addresses and governance (Safe + module) when present |
| `/instances/:id` | one instance by 32-byte `instanceId` |
| `/instances/:id/params` | the instance's full scoring params (from the on-chain event, not a config file) |
| `/score-programs/:snapshot` | authenticated program/output-domain and registry-event provenance for a snapshot |

### Trust-graph scores and proofs

| Route | Serves |
| --- | --- |
| `/merkle/:snapshot/all` | every proven root for this network, newest first |
| `/merkle/:snapshot/:root` | one full tree: metadata plus every entry `{account, value, proof}` (`:root` may be the literal `current`) |
| `/merkle/:snapshot/:root/:account` | **the per-account bundle**: `{entry: {account, value, proof}}`, everything a contract call like `claim` or `castVote` needs |
| `/network/:snapshot` | the scored member list plus the counted vouch graph (what the network page renders) |
| `/network/:snapshot/status` | freshness: last landed root, whether a recount is running, how many attestations await the next epoch |
| `/network/:snapshot/checkpoints/:checkpointId/inputs` | the exact fold-ordered input set a checkpoint froze, the raw material for path 3 |
| `/account/:account/networks` | one account's profile (rank, score, proof-carrying tree CID, vouches in/out) across configured networks |
| `/account/:account/network/:snapshot` | the same profile for one network |
| `/account/:account/attestations` | every vouch sent or received by an account |

So the integration loop for an app is: `GET /merkle/<snapshot>/current/<account>` → hold
`{value, proof}` → pass both to your contract, which verifies against the on-chain root. If the
endpoint lied, the on-chain verification fails; the endpoint can deny you service but cannot forge
a score.

### Hypercerts scores (lane-2 program)

The hypercerts program scores AT protocol nodes rather than addresses; its bundles are keyed by
`nodeId`:

| Route | Serves |
| --- | --- |
| `/hypercerts/roots?snapshot=0x…` | known hypercerts roots, newest first |
| `/hypercerts/scores` · `/hypercerts/:snapshot/scores` | the full score set at the current root (`?root=` to pin one) |
| `/hypercerts/score/:nodeId` | `{nodeId, score, proof, root, ipfsHash, ipfsHashCid, totalValue, skippedDigest, anchorAcc, anchorCount, snapshot}` at the single instance's current root (`?snapshot=` / `?root=` override) |
| `/hypercerts/:snapshot/score/:nodeId` | the bundle at that snapshot's current root |
| `/hypercerts/:snapshot/:root/score/:nodeId` | the bundle at an explicit root (`current` allowed) |

These routes rebuild the proof with the guest's exact tree construction and cross-check the
recomputed root against the stored on-chain root before serving; a mismatch is a `409` with both
roots in the body, never a quietly wrong proof.

### Contributions rounds (payout program)

`/contributions/rounds`, `/contributions/:snapshot/round`, `/contributions/:snapshot/claims`,
`/contributions/:snapshot[/root]/score/:claimUid`,
`/contributions/:snapshot[/root]/payout/:account`, and
`/contributions/:snapshot[/root]/audit/:claimUid` serve the round state, per-claim scores, and the
per-account payout bundles the payout page claims through. Details in
[`./contributions/interfaces.md`](./contributions/interfaces.md).

### Everything else

`/vault/:instanceId` reports a network's proving tank (balance, burn rate, unpaid roots). The root
path and `/graphql` serve Ponder's GraphQL API over the full indexed schema, and `/sql` exposes the
Ponder client protocol, for queries these routes don't cover.

## 3. In-browser: recompute the scores yourself

`frontend/lib/pagerank` is a TypeScript port of the canonical Rust core
(`packages/pagerank-core`): fixed-point Trust-Aware PageRank, the byte encodings, the OZ merkle
tree, and the CID construction. It is held byte-identical to the Rust guest by shared golden
vectors (`../../test/golden/trust-graph.json`, exercised by `frontend/lib/pagerank/golden.test.ts`
and the Solidity golden suites), so what it computes is what the zk proof proves.

That gives an app a third option: don't just check membership, recompute the scores and compare
the root.

```ts
import { compute } from '@/lib/pagerank'   // frontend/lib/pagerank

const result = compute({ edges, params })
// result.journal.outputRoot — compare with snapshot.getLatestState().root on chain
// result.scores, result.blob, result.cid — the full recomputed score set
```

- `edges` are the network's folded vouch records. The indexer serves the exact fold-ordered input
  set a checkpoint froze at `/network/:snapshot/checkpoints/:checkpointId/inputs`, and the browser
  can cross-check the accumulator commitment against `resolver.getCheckpoint(id)` over RPC before
  trusting it (this is what the app's own settings preview does).
- `params` come from `/instances/:id/params`, which is itself decoded from the on-chain
  `InstanceCreated` event.
- `proofFor` / `buildTree` from the same package derive any account's merkle proof locally, so an
  app can serve proofs to its users without depending on this project's indexer at all.

If the recomputed root equals the on-chain root, you have independently re-derived the entire
score set from public inputs; the zk proof exists so that contracts don't have to do this, not so
that you can't. The from-nothing version of this exercise (public data only, no repo trust) is
[`../verify/reproduce-an-epoch.md`](../verify/reproduce-an-epoch.md).

One honest caveat: the port lives in this repo as an app library; it is not published as an npm
package today. Vendoring the `frontend/lib/pagerank` directory (it depends only on `viem`) is the
current way to use it outside this frontend.

## Choosing a path

| You are… | Use | Trust required |
| --- | --- | --- |
| a contract gating or paying by score | path 1 | none: the chain verifies |
| an app showing scores, ranks, members | path 2, verifying bundles via path 1 semantics | none if you verify; availability only |
| an auditor, or an app that must not trust our indexer | path 3 (plus path 1 for the root) | none |

## Related

- [`./create-a-network.md`](./create-a-network.md) — standing up the network these scores come from
- [`../concepts/algorithm.md`](../concepts/algorithm.md) — what the scores mean and how they are
  computed
- [`./run-a-prover.md`](./run-a-prover.md) — how roots keep landing (and what happens when they
  don't)
- [`../verify/reproduce-an-epoch.md`](../verify/reproduce-an-epoch.md) — reproduce a proven epoch
  from public data alone
