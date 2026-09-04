# Agent delegation: governance, vouching, and the operations in between

**Status:** accepted and implemented (Stages 1–4); graph-native research split to #77

**Date:** 2026-08-13; implementation decision recorded 2026-08-14

**Scope:** how a user delegates trustgraphs operations (voting, vouching, contribution flows,
protocol upkeep) to an AI agent, with the user able to overrule the agent. This document now
records the shipped v1 contract/frontend/operator decision; it does not change a score or proof
claim. Agent *identity and reputation* is a separate
track, covered in [`ERC8004_AGENT_REPUTATION.md`](./ERC8004_AGENT_REPUTATION.md); this document
is about agents *acting on a user's behalf*.

## Outcome

The driving user story:

> As a user, I want to delegate DAO governance operations to my agent, and I want to overrule
> it if I disagree. Maybe I even want to delegate vouching or other operations.

Four findings shaped the design (the first and fourth describe the pre-implementation state):

1. **Every user action was authorized by `msg.sender` on a plain transaction.** The shipped EAS
   relay is now the one signature path: the frontend signs EAS 1.3.0 typed data and the constrained
   server relays it. Identity, scores, voting power, and payouts remain keyed by the signer/principal.
2. **A large class of operations is already delegable by design.** Proposal execution, payout
   claims, epoch triggers, proof submission, and prover funding are all deliberately
   permissionless or anyone-can-relay. An agent with its own key can do all of them today with
   zero protocol changes.
3. **EAS shipped a dormant delegation seam.** `attestByDelegation` / `multiAttestByDelegation` /
   `revokeByDelegation` are in the deployed EAS contract and in our generated ABI. The v1 build
   uses `multiAttestByDelegation` for both singleton and batch creation. EAS
   sets `attestation.attester` to the EIP-712 *signer*, and `EASIndexerResolver` folds
   `attestation.attester` into the accumulator, so a relayed vouch scores identically to a
   direct one with zero Solidity changes. This gives "agent drafts, human signs, agent relays"
   for every EAS-shaped operation (vouch, rate, respond) as a frontend-only build.
4. **Voting with human override needed one small contract change.** `MerkleGovModule` previously
   enforced one immutable vote per address. It now implements the recommended
   delegate-votes-provisionally, principal-vote-is-final rule, with exact stored-power tally
   replacement and indexed receipts.

The recommended policy line, argued in the threat model: **autonomous voting under policy is
acceptable; autonomous vouching is not.** Vouches are the security root of the whole system,
so delegated vouching should stay human-signed (the EAS delegated-attestation model), while
voting can be safely automated because a compromised voting delegate can only misspend
existing weight, is publicly visible, and is overridable.

## Current authorization surface

What a user can do, and how each action is authorized today. All file references are relative
to the repo root.

| Operation | Where | Authorization |
|---|---|---|
| Vouch / create EAS records | direct EAS or human-signed `multiAttestByDelegation`, called from `packages/frontend/hooks/useAttestation.ts` | EAS recovers the signer as `attester`; relay is chain/contract/schema allowlisted and zero-value only |
| Rate, submit, respond (contributions) | same hook, three EAS schemas behind `ContributionResolver` | same draft-review-sign-relay path when enabled |
| Propose / vote | `MerkleGovModule.propose` / `castVote` / `castVoteAsDelegate` | principal merkle proof against the proposal-pinned root; one provisional delegate vote, then at most one final principal vote |
| Execute a passed proposal | `MerkleGovModule.execute` | **permissionless** |
| Claim a payout | `MerkleFundDistributor.claim(distributionIndex, account, value, proof)` | **anyone can claim on behalf of an account**; funds go to `account`, not `msg.sender` |
| Epoch trigger / proof submission / prover bounty | `MerkleSnapshot.trigger` / `submitProof`, `ProvingVault.submitAndClaim` / `claim` | **permissionless**; the bounty `recipient` is bound into the journal digest so proofs cannot be replayed for a different payee |
| Fund the prover | `ProvingVault.depositETH` / `depositUSDC` | permissionless |
| Anchor an offchain attestation log | `AnchorRegistry.anchor` | governance-admitted `ANCHORER_ROLE`; head semantics remain owner/guest authenticated |
| Parameter changes, cancel, admin | `onlyOwner` / role-gated (`CONSTITUTIONAL_ROLE`, `OPERATIONAL_ROLE`, timelock) | out of scope for user-level delegation |

Identity is the address. `nodeId = keccak256(abi.encode(address))` everywhere; ENS is
input-resolution sugar; atproto DIDs exist only in the hypercerts lane. There is no
delegation, operator, session-key, or permit primitive anywhere in `contracts/src/`. The one
existing automation pattern is `zk/operator/`: a daemon holding a raw private key that only
touches permissionless functions. That is the current de-facto delegation model: hand a bot
its own key.

Because everything keys off `msg.sender`, there is a structural shortcut available at the
account layer: anything that lets an agent transact *as the user's address* (EIP-7702
delegated EOA code with scoped session keys) makes every operation delegable at once with
zero protocol changes. That option is real and evaluated below, but it is not the
recommendation for voting, because it cannot express "overrule after the fact" (see Design A
vs Design B).

## Threat model: not all delegations are equal

Rank operations by the blast radius of a compromised or misbehaving agent:

1. **Relay and upkeep ops (harmless).** Execute, claim, trigger, submit proofs, fund the
   prover. Already permissionless; the contracts are designed so a malicious caller can at
   worst waste their own gas. Payouts always go to the entitled `account`.
2. **Voting (bounded).** A rogue voting delegate can misspend the user's existing voting
   weight on live proposals. It cannot mint weight, cannot vote twice, and every vote is a
   public, attributable event. With the override design below, damage is also reversible
   within the voting window.
3. **Vouching (the security root).** Vouches shape scores, and scores *are* voting power and
   reward share. A compromised agent with autonomous vouch rights can rewire the user's
   outbound trust edges and feed a Sybil ring real influence, which is precisely the attack
   Trust-Aware PageRank exists to prevent. Vouches are revocable, so damage is bounded to
   roughly an epoch, but the norm matters: the graph's meaning degrades if edges stop being
   human judgments.
4. **Proposing (arbitrary calldata).** `propose` carries `targets/values/calldatas` executed
   by the Safe. An agent that can propose can attempt treasury drains and rely on voter
   inattention. Highest stakes per action.

This ordering drives the policy recommendation: automate 1 freely, automate 2 with override,
keep 3 human-signed, and keep 4 human-initiated (an agent may *draft* proposals, but a human
submits them).

## Voting with human override

The requirement is: the agent votes on the user's behalf; the user can overrule it. The
current module cannot express this: `hasVoted[proposalId][voter]` is set on first vote and
there is no path to change or replace a vote. Two designs follow; they are complementary, not
rivals.

### Design A: overrule by preemption (zero contract changes)

Use first-vote-wins in the user's favor:

1. When a proposal enters its voting window, the agent immediately publishes its analysis and
   intended vote to the user. This is a notification, not a transaction.
2. If the user disagrees, they simply vote themselves; `hasVoted` then blocks the agent.
3. If the user stays silent, the agent casts the vote near the end of the window (for
   example at 80% elapsed), transacting as the user's address via an EIP-7702 session key
   scoped to `castVote` on this one module, or as itself if Design B ships first.

Properties: ships with no audit surface; the overrule window is *before* the agent's vote
only; a user who changes their mind after the agent votes is stuck; if the agent fails near
the deadline the vote silently does not happen. Design A is the right interim mode and its
notification loop is required infrastructure for Design B anyway.

### Design B: principal-overrides-delegate in the module (shipped)

One precedence rule: **a delegate's vote is provisional; the principal's own vote is final.**

Current storage (`MerkleGovModule`):

```solidity
mapping(uint256 proposalId => mapping(address voter => bool)) public hasVoted;
mapping(uint256 proposalId => mapping(address voter => VoteType)) public votes;
```

Shipped delta (the implementation also stores power and original delegate for defensive exactness
and durable attribution):

```solidity
/// principal => delegate; address(0) = none. One delegate per principal.
mapping(address => address) public voteDelegate;

/// true when the recorded vote for (proposalId, principal) was cast by the delegate
mapping(uint256 => mapping(address => bool)) public votedByDelegate;
mapping(uint256 => mapping(address => uint256)) public votePower;
mapping(uint256 => mapping(address => address)) public delegateVoter;

function setVoteDelegate(address delegate) external;   // revoke with address(0)

function castVoteAsDelegate(
    address principal,
    uint256 proposalId,
    VoteType voteType,
    uint256 votingPower,
    bytes32[] calldata proof,
    string calldata reason
) external {
    if (voteDelegate[principal] != msg.sender) revert NotVoteDelegate(principal, msg.sender);
    if (hasVoted[proposalId][principal]) revert AlreadyVoted(); // delegate never overwrites
    // verify principal's merkle proof against the proposal-pinned root (existing helper),
    // then _castVote(proposalId, principal, voteType, votingPower)
    votedByDelegate[proposalId][principal] = true;
    emit DelegateVoteCast(proposalId, principal, msg.sender, voteType, votingPower, reason);
}
```

And in the principal path of `castVote`: if `votedByDelegate[proposalId][msg.sender]` is set,
subtract the delegate's recorded `(voteType, votingPower)` from the tally, overwrite the
receipt, clear the flag, and emit `VoteOverridden(proposalId, principal, oldVote, newVote)`.
A principal's own vote still cannot be changed; the only overwrite allowed, ever, is
principal-over-delegate, once.

Why this is cheap in this specific architecture:

- **The delegate needs no secrets and no funds custody.** Voting power is a merkle proof
  against the published score root: public data anyone can reconstruct from the IPFS-published
  scores. Authorization is the `voteDelegate` mapping, so the agent transacts with its own
  key under its own identity. No session keys, no key sharing, revocation is one transaction.
- **The override tally math is exact.** Both votes prove against the same proposal-pinned
  root, so the principal's power equals the delegate-cast power; the override is a clean
  subtract-and-re-add. The override path re-verifies the principal's proof, so the power to
  subtract does not even need to be stored (though storing a full receipt is the more
  defensive spelling).
- **The semantic change is minimal.** No general vote-changing is introduced. Every existing
  invariant (one final human vote per address, immutable proposal-pinned root, quorum math)
  survives. `hasVoted` keeps its meaning.
- **It is legible.** `DelegateVoteCast` carries a machine-readable `reason`; the indexer can
  surface "your agent voted Yes: <reason> [Overrule]" and, publicly, anyone can see which
  votes were agent-cast and how often humans overrule their agents. The override rate is
  itself an interesting signal, and a candidate future input to the graph (see the
  "extra reputation for voting" item in `ROADMAP.md`).

The shipped contract, indexer and UI keep this audit-sensitive change narrow. The Solidity battery
covers all nine old/new vote-type combinations, stale/revoked/malicious delegates, replay and
double voting, pinned-root proofs, boundaries, quorum, and turnout conservation. Prior art for
principal-overrides-delegate tally accounting exists in the Governor ecosystem (ScopeLift's
Flexible Voting family and the L2 "override delegation" designs built on it) and is worth
cribbing test cases from.

Design note kept deliberately out of v1: `setVoteDelegate` could be an EAS attestation
instead of a mapping, making delegation itself an edge in the graph (visible, revocable,
potentially score-relevant). The mapping is the right v1; nothing in Design B blocks
upgrading, since the mapping can later be populated by a resolver.

## Delegated vouching and other EAS operations

For vouch, rate, and respond, the recommendation is **human-signed, agent-relayed**, via the
EAS delegated-attestation functions that are already deployed and already in the generated EAS
ABI (`packages/frontend/lib/contract-abis.ts`):

- The agent does the work: watches the graph, drafts vouches or a batch of contribution
  ratings, presents them with rationale.
- The user signs one EIP-712 payload (or one multi-attest payload for a batch).
- The agent relays via `attestByDelegation` / `multiAttestByDelegation`, paying gas, choosing
  timing, retrying. EAS records the *signer* as `attester`, so the resolver fold, the
  accumulator, and the proven scores are all unchanged.

The shipped frontend builds the EAS 1.3.0 typed message, signs in exact grouped nonce order, and
uses a server route constrained to one configured chain/EAS address, an explicit schema allowlist,
zero value, 15-minute deadlines, signature/nonce validation, simulation, and a 20-item batch cap.
The existing draft forms are the review surface for vouching, claims, ratings, and responses.

If fully autonomous vouching is ever wanted despite the threat model, constrain it: cap
confidence well below the human maximum, rate-limit edge creation, always allow autonomous
*revocation* (defensive direction), and require the delegation to be publicly visible. The
envelope-0 offchain path (`crates/envelopes/`, `AnchorRegistry.anchor` through an admitted
relayer) is the natural gasless endgame for agent-maintained attestation logs, but it is
dormant today (no factory deployment, empty `envelope0DomainSeparators` in the create
wizard) and should not gate any of the above.

## Account-layer alternative considered: EIP-7702 session keys

A 7702-delegated EOA with a policy module ("may call `castVote` on this module; may call EAS
`attest` on schema X with confidence ≤ N; expires in 30 days; may never call `propose` or
transfer value") makes the agent indistinguishable from the user on-chain and covers every
operation at once with zero protocol changes. It remains the right tool for Design A interim
voting and for users who want one mechanism across many protocols. It was not chosen as the
primary voting design because:

- it cannot express after-the-fact override (same address, `hasVoted` binds both);
- it hides delegation: on-chain observers cannot distinguish agent votes from human votes,
  which both weakens accountability and forfeits the override-rate signal;
- key-custody UX (granting, scoping, rotating session keys) is heavier than one
  `setVoteDelegate` transaction against a mapping.

## Staged build path

1. **Done: upkeep agent runbook.** An agent with its own funded key executes passed
   proposals, claims payouts to the user's address, triggers epochs, and keeps the
   ProvingVault topped up. Product/docs work only; pairs naturally with an ERC-8004 identity
   registration for the agent.
2. **Done: delegated EAS actions.** The EIP-712 signing helper, draft-review-sign UX, and
   constrained relay use `multiAttestByDelegation` for singleton and batch creation. This ships
   human-signed delegated vouching, rating, and responding with zero Solidity changes.
3. **Done: agent loop and preemption.** The runner watches proposals, loads agent-authored
   analysis, sends a digest-bearing intended-vote notification, and votes late in the window
   unless the principal preempts it. It uses the agent's own key through
   `castVoteAsDelegate`, and writes an observable receipt for every terminal outcome.
4. **Done: contract Design B.** `setVoteDelegate` + `castVoteAsDelegate` +
   principal-override in `MerkleGovModule`, indexer events, receipt/override UI. The step-3
   loop switches to `castVoteAsDelegate` under its own key and gains true after-the-fact
   override.
5. **Split to #77: delegation as part of the graph.** Delegation edges as attestations;
   agents as first-class reputation-bearing nodes per
   [`ERC8004_AGENT_REPUTATION.md`](./ERC8004_AGENT_REPUTATION.md); bonded agents (accountable
   delegates that stake a slashable bond). Differentiator: no other governance system's
   delegation graph is itself a ZK-proven trust graph.

## V1 decisions

1. Agents only relay human-signed vouches/ratings/responses; there is no autonomous-vouch mode.
2. One vote delegate per principal. Upkeep remains permissionless and needs no delegated scope.
3. Delegate votes count identically toward decisive quorum; the flag preserves attribution.
4. `reason` is calldata consumed into `DelegateVoteCast`, not contract storage.
5. The frontend requires confirmation of a tested notification channel before it calls
   `setVoteDelegate`. This is an explicit UI safety rail, not an on-chain invariant.

## References

- EAS delegated attestations: `multiAttestByDelegation` and `DelegatedAttestationRequest` in the
  deployed EAS contract, called through `packages/frontend/hooks/useAttestation.ts` and
  `packages/frontend/app/api/eas-relay/route.ts`.
- `MerkleGovModule` voting internals: `castVote`, `_castVote`, `hasVoted`, `votes`,
  `_verifyMerkleProof` (proposal-pinned root).
- Anyone-can-relay precedents in this repo: `MerkleFundDistributor.claim`,
  `MerkleSnapshot.trigger` / `submitProof`, `ProvingVault.claim`, `AnchorRegistry.anchor`,
  `MerkleGovModule.execute`.
- ScopeLift Flexible Voting (Governor extensions with delegate/principal tally splitting):
  https://github.com/ScopeLift/flexible-voting
- EIP-7702 (EOA code delegation, live since Pectra):
  https://eips.ethereum.org/EIPS/eip-7702
- ERC-8004 Trustless Agents (agent identity registries):
  https://eips.ethereum.org/EIPS/eip-8004 and
  [`ERC8004_AGENT_REPUTATION.md`](./ERC8004_AGENT_REPUTATION.md)
