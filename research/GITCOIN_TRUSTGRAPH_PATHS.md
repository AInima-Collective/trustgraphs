# TrustGraph × Gitcoin: Two Integration Paths

*Prepared by the TrustGraph team for discussion with Gitcoin, July 2026.*

## Executive summary

We propose two ways to bring TrustGraph's sybil-resistant reputation scores into Gitcoin
governance. Both work with the new `GitcoinGovernorWithGuardian` exactly as deployed, requiring
zero changes to the governor, and both can be fully unwound by Gitcoin governance in a single
transaction.

1. **TrustGraph SubDAO.** A separate Safe governed directly by trust scores, holding only the
   funds and powers Gitcoin chooses to grant it. Every scored community member votes, one
   proof-backed vote at a time, on how that scoped budget is used.
2. **TrustPool.** A pool of treasury GTC whose voting power is cast in the main governor by
   trusted community members, each wielding a slice of the pool proportional to their proven
   trust score. The pool uses the fractional voting extension already built into Gitcoin's new
   governor, and every vote's weight is derived at vote time from a zero-knowledge-proven score.
   Stale or inflated voting power is not merely discouraged: it is arithmetically impossible.

The paths answer different questions. The SubDAO gives the community's trust graph its own
scoped decision space; TrustPool gives it weight inside Gitcoin's main decision space. They are
not mutually exclusive, and they share all of their underlying infrastructure.

## TrustGraph in brief

TrustGraph turns community attestations into governance-grade reputation:

- Community members make trust attestations to one another through the Ethereum Attestation
  Service (EAS). Creating or revoking an attestation is an ordinary, cheap transaction.
- Scores are computed by Trust-Aware PageRank, a PageRank variant anchored to a curated seed set
  so that sybil rings and spam clusters cannot accumulate influence. Trust flows only along
  paths that trace back to seeds.
- Each epoch, the full score computation runs inside a zero-knowledge proof (SP1 zkVM). Anyone
  may run the prover. The chain verifies the proof and stores a single 32-byte merkle root
  committing to every account's score, together with the total score and a content hash that
  publishes the full tree publicly.
- An on-chain accumulator guarantees input completeness: the proof must incorporate every
  attestation, so a prover cannot censor edges it dislikes.
- The contract keeps the full history of roots, so "which scores were current at block B" is
  answerable on-chain forever.

Two properties matter for everything below. First, cost: attestations and score updates cost
nothing on-chain beyond the attestation itself; a single attestation can change thousands of
scores and the chain never notices, because scores live behind the proven root. Second, trust:
score integrity rests on a public proof system, not on any operator, committee, or bot.

## What both paths share

- **No governor changes.** Path 1 lives beside the governor entirely. Path 2 interacts with it
  only through interfaces it already exposes.
- **One-transaction reversibility.** Gitcoin governance can disable the SubDAO's module or
  recall TrustPool's funds at any time.
- **A Gitcoin-scoped trust graph.** Both need an EAS attestation schema, a seed set (for
  example: stewards, or Passport-verified long-term contributors), and an epoch cadence. This
  groundwork is shared, so it is never wasted whichever path is chosen.
- **Cost scales with participants, never with the graph.** On-chain cost is per voter (Path 1)
  or per delegate vote (Path 2). Attestation volume and community size are free.

## Path 1: TrustGraph SubDAO

### Mechanism

A dedicated Safe holds the SubDAO's budget. A Zodiac governance module (already built and
running in the TrustGraph stack) turns proven scores into direct voting power over that Safe:

- **Propose.** Any scored account may propose actions, submitting a merkle proof of membership
  alongside the transaction payload.
- **Vote.** Direct democracy over scores: each voter casts Yes, No, or Abstain with a proof of
  their score. Proofs verify against the root that was current when the proposal was created,
  so a mid-proposal score update can never shift an open vote.
- **Execute.** Proposals that reach quorum (a configurable share of total voting power) execute
  their actions through the Safe.
- **Refresh.** Each epoch's proven root updates everyone's voting power automatically, with no
  per-account transactions.

### Containment: only what it is given

The SubDAO's power is precisely the Safe's holdings plus any roles granted to the Safe's
address, and nothing else:

- **Funds.** Gitcoin's timelock transfers a budget to the Safe. Top-ups are ordinary governance
  proposals.
- **Powers.** Any permission Gitcoin can grant to an address (round-operator rights, an
  allowance, an allowlist role) can be granted to the Safe, and revoked the same way.
- **Backstop.** Gitcoin's timelock sits on the Safe as a second module, so disabling trust-based
  control or sweeping funds home is a single main-DAO proposal. The pilot's worst case is the
  budget, full stop.

### Participant experience and cost

Every scored account participates directly: no delegates, no token custody anywhere in the
path. A vote costs roughly 50k to 80k gas (one merkle proof, built automatically in the
browser from the published tree). Participation happens in the TrustGraph app, which indexes and
displays proposals, votes, scores, and the attestation graph. The honest tradeoff: SubDAO
votes live in TrustGraph tooling rather than Tally, though the SubDAO itself is fully legible
to Gitcoin governance as a budget line.

### Maturity

The module and its full stack (attestations, prover, indexer, frontend) run end-to-end today.
Before carrying real funds it will complete a scheduled hardening pass (proposal-threshold
gating, quorum edge cases, config authority) and an external audit alongside the rest of the
TrustGraph contract suite. It is the fastest credible pilot of trust-weighted governance
running a real budget.

## Path 2: TrustPool

### The design principle: power that cannot go stale

Any system that hands out standing voting power must answer one hard question: what happens
when a score drops? If power is materialized (tokens sitting in a delegate's wallet or vault),
someone must send a transaction to take it back, and every design we examined for forcing that
transaction (keepers, bounty races, bonds and slashing) amounts to deterring evil rather than
preventing it.

TrustPool takes the other branch: voting power is never materialized at all. It is computed,
per vote, from a proof of the voter's current score, at the moment the vote is cast. A dropped
score does not need to be forced back; the very next vote is simply smaller, arithmetically.
There is nothing to sweep, nothing to expire, no keeper to run, no bond to slash. The proof
system makes an inflated vote inexpressible.

### Mechanism

Gitcoin's new governor includes OpenZeppelin's `GovernorCountingFractional` extension, designed
precisely so that a contract holding pooled voting power can split its weight and cast rolling
partial votes on behalf of the people it represents. TrustPool is a client of that extension:

1. The DAO allocates a pool of treasury GTC to the TrustPool contract, which delegates the
   pool's voting power to itself, once. The DAO's timelock can resize or withdraw the pool at
   any time.
2. A trusted community member votes by submitting their score and its merkle proof. The
   contract looks up the score root that was current at the proposal's snapshot block (the
   root history makes this a simple on-chain lookup), verifies the proof against that root,
   and computes the voter's weight: their share of the pool, proportional to score, with a
   minimum-score floor.
3. The contract casts exactly that weight as a fractional vote (For, Against, or Abstain) in
   the main governor. Each participant votes once per proposal; the sum of all shares can never
   exceed the pool, by construction; and the governor independently enforces the pool's total
   weight as a hard ceiling, so even a buggy or malicious pool contract could not exceed its
   granted power.

### Validated against the real counting module

We built an executable prototype against the exact OpenZeppelin module Gitcoin's governor
imports, and verified end to end:

- Per-participant fractional casts accumulate correctly and tallies match each voter's
  proportional entitlement exactly.
- The governor rejects any attempt by the pool to cast beyond its snapshot weight, providing
  defense in depth beneath the pool's own accounting.
- A score root published after a proposal's snapshot does not disturb voting on that proposal;
  proofs verify against the root that governed at the snapshot.
- **Stale scores are inexpressible.** Once a newer root governs, an old higher score fails
  proof verification outright, and the current score yields the smaller weight automatically.
- Gas per vote: roughly 102k for the first program vote on a proposal and 61k for each
  subsequent one, paid by the voter, only when voting. There is no standing per-epoch cost at
  all.

### Voter experience

Joining is a single opt-in. Voting is one click in the TrustGraph app (score proofs are
constructed automatically in the browser), or gasless via a signed message that anyone may
relay. Votes appear on-chain per participant through the pool's events, with full attribution
of who voted, how, and with what weight; personal GTC held by participants continues to work
natively in Tally, completely unaffected. The one tradeoff to state plainly: program voting
power does not appear as standing delegate weight on Tally profiles, because it exists only at
the moment of voting. We consider this the honest representation: in TrustPool, influence is
something the community's trust continuously generates, not a balance someone holds.

Because proposal rights in the governor are also weight-based, TrustPool can additionally offer
a proposal passthrough: participants above a score threshold may submit governance proposals
through the pool, giving high-trust contributors proposal access without token wealth.

### Why not a delegation program (Franchiser)?

We evaluated building this as a delegation program in the style of Franchiser, which Gitcoin is
adopting for other purposes: treasury GTC parked in per-delegate vaults, sized by trust score,
with expiry-based recall. It works, and we designed it in depth. We set it aside for one
reason: materialized power can go stale. Between a score drop and a vault resize there is
always a window where yesterday's trust votes with today's weight, and closing that window
requires either trusted infrastructure or economic deterrence. TrustPool closes it by
construction. Franchiser remains, in our view, the right tool for its intended job (delegating
to known parties for a term); score-driven power, which changes every epoch, wants to be
computed rather than parked.

## Side by side

| | **TrustGraph SubDAO** | **TrustPool** |
| --- | --- | --- |
| Decision space | its own scoped domain | all of Gitcoin governance |
| Power source | funds and roles granted to a Safe | pooled treasury GTC, cast fractionally |
| Who participates | every scored account, directly | opted-in participants above a score floor |
| Staleness | impossible (proofs per vote) | impossible (proofs per vote) |
| Standing infrastructure | prover per epoch (permissionless) | prover per epoch (permissionless) |
| Voting venue | TrustGraph app | TrustGraph app; votes land in the main governor and are visible in Tally as pool casts |
| Gas | ~50k–80k per voter per proposal | ~61k–102k per voter per proposal |
| Token movement | none | pool funding and withdrawal only |
| Blast radius | the granted budget | the pool's voting weight |
| Unwind | disable module or sweep Safe | withdraw pool |
| Status | running end to end today; hardening + audit before funds | prototype validated against the production counting module; build + audit next |
| What it demonstrates | trust-weighted governance running a real budget | trust scores legitimately steering token governance |

## If both: a natural sequence

The SubDAO can ship first: it is the fastest path to trust-weighted governance controlling
real value, and standing it up creates everything TrustPool needs (the Gitcoin attestation
schema, seed set, epoch cadence, prover operations, and indexing). TrustPool then reuses the
same proven roots; the snapshot contract already supports multiple consumers. Run the SubDAO
as the community's scoped budget arm, and TrustPool as the community's voice in main
governance, both fed by one trust graph.

## Open questions for discussion

1. **Seed set.** Who anchors the Gitcoin trust graph: stewards, long-standing Passport-verified
   contributors, a hybrid? This is the most consequential social parameter.
2. **Scope and size.** For the SubDAO: which budget or powers make a meaningful pilot? For
   TrustPool: what pool size gives the program real voice while the DAO builds confidence?
3. **Epoch cadence.** How often should scores refresh? Weekly to monthly all work technically;
   the tradeoff is freshness versus prover operations.
4. **Chain topology.** The governor and GTC live on mainnet while much of Gitcoin's
   attestation activity (Passport, EAS) lives on Optimism. Attestations can accrue where the
   community already is, with the proven root relayed to mainnet, or directly on mainnet.
   Both are supported; the choice is about where attesting should be cheapest.
5. **Parameters.** Minimum score floors for voting and proposing, quorum for the SubDAO, and
   the governance process for adjusting each.

We are happy to walk through the designs, the prototype, and the security architecture in as
much depth as useful.
