# TrustPool Spike: Fractional Voting Client Against OZ GovernorCountingFractional

**Status:** Spike complete, all questions answered affirmatively.
**Code:** `test/spike/TrustPoolSpike.t.sol` (6 tests, all green, `forge test --match-path "test/spike/TrustPoolSpike.t.sol"`)
**Context:** Validates the TrustPool design (Path 2 of `research/GITCOIN_TRUSTGRAPH_PATHS.md`):
a pooled manager that holds program GTC, self-delegates, and casts per-delegate fractional
votes on `GitcoinGovernorWithGuardian`, with each delegate's weight derived at vote time from
a merkle proof against the root that was current at the proposal snapshot.

## What Gitcoin's governor actually uses

`ScopeLift/gitcoin-gov-upgrades` imports **OpenZeppelin's** `GovernorCountingFractional`
(`@openzeppelin/contracts/governance/extensions/`, available since v5.1, itself derived from
ScopeLift's flexible-voting original), not ScopeLift's standalone module. Our node_modules has OZ
**5.4.0** with the identical file, so the spike compiles against the exact production dependency.
Key semantics confirmed by source + tests:

- **Rolling partial casts are first-class.** `usedVotes(proposalId, account)` tracks cumulative
  weight; the natspec explicitly calls out "integrations that allow delegates to cast rolling,
  partial votes." Fractional casts use `support = 255` with `params =
  abi.encodePacked(uint128 against, uint128 for, uint128 abstain)`.
- **The ceiling is enforced by the governor, not the client.** Each cast may use at most
  `checkpointed weight at snapshot − usedVotes`; exceeding it reverts
  `GovernorExceedRemainingWeight`.
- **A nominal (Bravo) vote consumes ALL remaining weight.** The pool must therefore only ever
  cast fractionally, never nominally (a nominal cast would spend the whole pool's remainder on
  one delegate's preference). Pool-side invariant, trivial to enforce.
- **`COUNTING_MODE` = `support=bravo,fractional&quorum=for,abstain`**: For and Abstain count
  toward quorum, Against does not. Program participation (including abstentions) helps quorum.

## Findings (test ↔ claim)

| # | Claim | Test | Result |
| --- | --- | --- | --- |
| A1 | Per-delegate fractional casts accumulate; tallies match `poolCap·score/totalScore` exactly | `test_rollingFractionalCasts_tallyPerDelegate` | PASS |
| A2 | Governor caps the pool at its snapshot weight even if the manager is buggy (defense in depth: our Σ-entitlements ≤ poolCap invariant is *backstopped* by the token checkpoint) | `test_governorCapsPoolAtSnapshotWeight` | PASS, exact revert selector |
| A3 | A root landing *after* the snapshot does not disturb voting under the snapshot root (history lookup ≡ `MerkleSnapshot.getStateAtBlock`) | `test_snapshotRootGoverns_evenAfterNewerRootLands` | PASS |
| A4 | **Stale scores are inexpressible**: once a newer root governs the snapshot, an old-score proof fails; the current score verifies and yields the smaller weight arithmetically | `test_staleScoreInexpressible` | PASS |
| A5 | Per-delegate double-vote blocked pool-side (`delegateVoted`) | `test_delegateCannotDoubleVote` | PASS |
| A6 | Gas per delegate vote | `test_gasPerDelegateVote` | **101,948 first vote on a proposal, 60,954 subsequent** (warm tally slots) |

A4 is the design's core safety claim, demonstrated end-to-end: there is no stored allocation to
go stale, no forced sync, no keeper, no bond. The weight *is* the proof.

## Deltas between spike and production (all judged non-load-bearing, verify in build)

1. **Token/votes module:** spike uses `ERC20Votes` + `GovernorVotes`; production is GTC (COMP)
   + ScopeLift's `GovernorVotesComp` reading `getPriorVotes`. Identical role (checkpointed weight
   at snapshot feeds `_countVote`'s `totalWeight`); the counting module under test is byte-identical.
   GTC's uint96 checkpoints comfortably bound any realistic poolCap, and fractional's uint128
   packing is a superset of uint96.
2. **History source:** spike's `MockSnapshotHistory.stateAtBlock` mimics
   `MerkleSnapshot.getStateAtBlock` (at-or-before semantics) with linear scan; production uses the
   real binary search and binds `totalValue` in the same `MerkleState` as the root — exactly what
   the pool needs (`totalScore` must come from the state, never from the caller; the spike already
   does this).
3. **Version drift:** gitcoin-gov-upgrades pins `pragma ^0.8.35` and its own OZ commit
   (`foundry.lock`); re-run this spike against their locked dependency during the build phase.
4. **PreventLateQuorum / SettableFixedQuorum / guardian:** not in the spike harness; they wrap
   timing and quorum values, not counting semantics. No interaction expected with fractional
   casts; confirm in an integration test against the real `GitcoinGovernorWithGuardian` (their
   repo's test suite provides a harness to fork).

## Production surface implied by the spike

The PoC manager is ~80 lines. Production adds: θ floor, delegate opt-in/registry, EIP-712
meta-votes (delegate signs, anyone relays → gasless voting), a θ-gated `propose()` passthrough
(program power satisfying `proposalThreshold` via the pool), events for per-delegate vote
attribution (indexer + any governance UI), timelock-owned `poolCap`/`withdraw`, and the pool
top-up path. Nothing in the spike suggests the core needs to be materially bigger.

## Verdict

The mechanism works exactly as designed against the exact OZ module Gitcoin's new governor uses.
Vote-time proof against snapshot-root history gives structural staleness-immunity ("can't do
evil") with zero governor changes, zero standing infrastructure, and ~61–102k gas per delegate
per proposal, paid by the voter. TrustPool replaces TrustFranchiser as Path 2.
