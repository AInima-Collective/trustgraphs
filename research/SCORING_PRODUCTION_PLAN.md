# Making the score production ready

**Status:** plan, 2026-08-22, revised after cross-agent review and then **scoped down**.
Releases 4 and 5 in this document are no longer planned: the single-core rewrite is filed as a
code-quality item without a forcing reason, and complaints moved to
[trustgraphs#104](https://github.com/JakeHartnell/trustgraphs/issues/104). The earned founder
prior in Release 3 is also out, replaced by a template default of three to five founders. The
findings and measurements below stand; [`GOAL.md`](../GOAL.md) is the live plan.
Tracked as a program in [`GOAL.md`](../GOAL.md), which carries the milestone checklists, the
open decisions, and the testnet release gate, and is the live document where this one and the
review disagree. The review record is [`DISCUSSION.md`](../DISCUSSION.md); its threads are
numbered `F1`-`F9` and are cited below. Two corrections to this document's original claims are
marked inline.
Companion to [`SCORING_NEXT_STEPS.md`](./SCORING_NEXT_STEPS.md), which covered what the score
*says*. This one covers whether the thing that computes it is ready to be run by strangers, on
real graphs, for money.

## The short version

The scoring core is correct and it is proven. It is also quadratic in the number of accounts,
which means it works beautifully on the graphs we test with and cannot be afforded on the graphs
we want. A twenty-five account network already costs 73 million cycles in the zkVM. Two hundred
accounts costs 2.7 billion. Nobody has hit this yet because no network has grown past the demo.

The good news is that the fix is not a redesign. We measured a straightforward rewrite of the
inner loop that produces **the same scores, to the last digit, on the shipped reference vector
and on every configuration we tried**, and runs 6x to 169x faster over the sizes we measured,
with the gap widening as the graph grows. That is the first release below, and it is the safest
change in the document: the argument for its correctness is that nothing changes.

The same measurement turned up something worth knowing on its own: the operator estimates its
own cost with a formula that is linear in attestations, so at 200 accounts it prices a job at
50 million cycles and gets billed for 2.7 billion. Every budget guard and fee band in the system
is downstream of that estimate.

Everything after that is the work of turning four ranking implementations into one, closing the
admission gate that the earlier review found, and clearing out the research code that got swept
into the production tree during the reorg.

There is also a timing fact that shapes the whole plan. **Nothing is deployed to a public
chain.** The Optimism path is slated for retirement, Sepolia has not happened, mainnet is the
target. Every breaking change in this document is free today and expensive later. This is the
cheapest moment there will ever be to change the parameter encoding, and it will not come again.

## What to greenlight first

If only one thing gets done: **Release 1, the loop rewrite.** It is the only item here that is
both urgent and free of judgement calls. It unblocks every network larger than a demo, its
correctness argument is mechanical, and it makes the parameter and mechanism work in Release 2
easier to review because the diff stops being tangled up with performance.

Release 0, the cleanup, is a couple of hours and makes everything after it legible.

The one decision that needs your call before Release 2 is whether to take the parameter
encoding break now. My recommendation is yes, for the timing reason above.

## What we have

Four separate implementations of graph ranking live in the tree.

| Where | Size | Used by | Shape |
|---|---|---|---|
| `crates/pagerank-core/src/pagerank.rs` | 235 lines | trust-graph, contributions, hypercerts, nostr-workspace, signer-sync, and the browser | pull loop, quadratic, normalised once at the end |
| `crates/weighted-prior-core/src/rank.rs` | 531 lines | the weighted-prior program | push loop, linear, exact whole-number apportionment, conserves mass every iteration |
| `crates/graph-reputation-core/src/lib.rs` | 725 lines | **nothing at all** | an ERC-8004 research spike |
| `crates/pagerank/src/graph_computer.rs` | 1,132 lines | one development example | the original floating-point version |

Plus `packages/frontend/lib/pagerank/` (1,825 lines of TypeScript), a hand-written port of the
first one that the browser runs for previews, kept in agreement with the Rust by seven reference
vector files.

So: one core carries five programs and the browser. A second, better-engineered core carries one
program. A third is dead. A fourth survives as a test fixture.

## What we found this pass

Everything below was measured against the production Rust, not against a model. The commands
that produce each number are in the last section.

### The rank loop is quadratic in accounts

For every recipient, the loop walks **every** account in the graph asking "did you vouch for
this person?", and for each one it re-adds up that account's entire outgoing weight from scratch.
That total does not depend on the recipient and does not change between iterations, but it is
recomputed once per recipient per iteration. The work is proportional to accounts x accounts x
vouches-per-account x iterations, where it should be proportional to vouches x iterations.

Measured natively, six vouches per account, 85% damping, iteration budget of 100:

| accounts | vouches | time |
|---|---|---|
| 100 | 600 | 0.016s |
| 400 | 2,400 | 0.236s |
| 800 | 4,800 | 0.846s |
| 1,600 | 9,600 | 2.49s |
| 3,200 | 19,200 | 8.80s |

Roughly three and a half times the work for twice the accounts, while the attestations only
double. That is the signature of a quadratic loop, slightly flattered by the iteration count
falling as the graph grows.

Inside the zkVM, where it actually matters, the same shape shows up in cycles. These are real
executor runs, not estimates, and each one checked `guest == native`:

| accounts | vouches | iterations run | guest cycles |
|---|---|---|---|
| 3 (the shipped reference vector) | 6 | 100 | 1.9 million |
| 25 | 144 | 24 | 72.7 million |
| 50 | 294 | 20 | 220.9 million |
| 100 | 594 | 17 | 714.8 million |
| 200 | 1,194 | 16 | **2.67 billion** |

Read the growth carefully: **the accounts double and the cost nearly quadruples, while the
number of attestations only doubles.** The third column explains why the early rows look milder
than that. These graphs settle in fewer iterations as they grow, which masks part of the
per-iteration cost, but the iteration count bottoms out at 16 and then the quadratic term is
all that is left: the last doubling costs `n^1.90`.

Two hundred accounts is a small club and it already costs 2.7 billion cycles per snapshot.
`cents_per_billion_cycles` is literally the unit the operator prices work in. For scale, the
Bitcoin OTC web of trust that we used for the earlier review has 5,881 accounts, which is
another five doublings from here.

### A rewrite that changes nothing exists, and we measured it

The loop can be turned inside out: instead of asking each recipient who vouched for them, walk
each account's vouches once and push its standing to the people it named. Each account's
outgoing total gets computed once, before the iterations start, instead of once per recipient
per iteration.

This is not an approximation. Every arithmetic operation, every truncation, and every rounding
boundary is the same one, performed in a different order over an operation that is associative.
We built it and compared:

The parameters vary deliberately from row to row, so the identity is shown across the settings
space rather than at one convenient point:

| graph | starting share | boost | decay | current | rewritten | speedup | identical? |
|---|---|---|---|---|---|---|---|
| **the shipped reference vector**, 3 accounts | 15% | 2 | 0.8 | too small to time | too small to time | | **yes** |
| 100 accounts, 6 vouches each | 100% | 1 | 0.8 | 9.9ms | 1.6ms | 6x | **yes** |
| 200 accounts, 4 vouches each | 15% | 2 | 0.8 | 27ms | 2.4ms | 11x | **yes** |
| 400 accounts, 8 vouches each | 50% | 1 | 1.0 | 600ms | 38ms | 16x | **yes** |
| 800 accounts, 6 vouches each | 100% | 1 | 0.6 | 548ms | 7.3ms | 76x | **yes** |
| 1,600 accounts, 6 vouches each | 15% | 3 | 0.8 | 2.74s | 36ms | 76x | **yes** |
| 3,200 accounts, 6 vouches each | 100% | 1 | 0.8 | 8.48s | 50ms | **169x** | **yes** |

Plus four graphs containing a large component that no trusted path reaches, which is the case
where the two loops have the most opportunity to disagree. Identical in all four.

**Correction (F4).** The candidate that produced these tables lives in a scratch crate outside the
repository, so nothing a reviewer can run backs them. "Already verified, not proposed" overstates
what is checked in. The candidate, its generators and its exact seeds, together with a test-only
copy of the current pull kernel as a differential oracle, should be committed *before* the
rewrite, so the oracle exists before the change it polices.

Two things a careful implementer needs to preserve, because they are the only places where the
transformation is not mechanical:

- The current loop measures its stopping condition only over accounts a trusted path reaches.
  Unreachable accounts are given their teleport value and skipped before the delta is taken. The
  rewrite must skip them the same way, or it will run a different number of iterations.
- The rewrite makes an invariant load-bearing that is currently only implied: every account
  named by a vouch must be in the node set. `reconcile::build_graph` guarantees it, but the four
  other programs build their own graphs. It should be asserted, not assumed.

### The prover prices the work as if it were linear, and every guard is downstream of that

This is the finding with the sharpest edge, because it is the one that decides whether a snapshot
gets produced.

`InstanceSize::estimated_cycles` (`crates/operator-core/src/types.rs:247`) is

```
base_cycles + (leaf_count + anchor_count) * cycles_per_input
```

with `BASE_CYCLES = 2,000,000` and `CYCLES_PER_INPUT = 40,000`. Linear in attestations. The work
is quadratic in *accounts*, and those are different numbers. Held against the executor runs
above:

| accounts | attestations | the model says | actually measured | model is wrong by |
|---|---|---|---|---|
| 3 | 6 | 2.2 million | 1.9 million | 0.9x, i.e. correct |
| 25 | 144 | 7.8 million | 72.7 million | 9x |
| 50 | 294 | 13.8 million | 220.9 million | 16x |
| 100 | 594 | 25.8 million | 714.8 million | 28x |
| 200 | 1,194 | 49.8 million | 2,670.5 million | **54x** |

The error doubles every time the membership doubles, which is exactly what a linear model of
quadratic work does. The comment above the constants says they were measured rather than guessed,
and they were: on the three-edge reference fixture, which is the single point in the whole range
where the model is right.

Everything the operator does about cost hangs off this number.

- `Policy::cycle_limit` is `BASE_CYCLES + MAX_PRICED_INPUTS * CYCLES_PER_INPUT` = **8.0 billion
  cycles**, and `MAX_PRICED_INPUTS = 200,000` attestations, which at six vouches each is about
  33,000 accounts. Projecting the measured exponent, 8 billion cycles is what a network of about
  **350 accounts** actually costs. The operator's stated ceiling and its real ceiling differ by
  roughly two orders of magnitude.
- `ProvingVault.MAX_PRICED_INPUTS` is the same number on-chain, deliberately duplicated so the
  fee band and the operator's limit name the same boundary. They do name the same boundary. The
  boundary is in the wrong place.
- The budget cap is `per_instance_usd_per_day = 25` at `cents_per_billion_cycles = 100`, so
  25 billion cycles a day. A 200-account network at 2.67 billion cycles a snapshot gets nine
  snapshots a day. Projecting again, a **650-account** network spends its entire daily budget on
  a single snapshot.

And because the guard compares the *estimate* against the limit rather than the truth, it fails
open: the operator accepts a job it priced at fifty million cycles and is billed for two and a
half billion.

After the rewrite the model can be made correct rather than merely closer. This is not a request
to recalibrate a constant, it is a request to make the constant meaningful.

**Correction (F1).** An earlier draft of this section said the work "really does become linear in
attestations" after the rewrite. That is wrong, and the reviewer was right to reject it. The push
rewrite makes the *ranking term* linear in edges per iteration; it does not make the guest linear
in anything. Reconciliation sorts, so it is `O(E log E)`; the output tree is `O(V log V)`; lane 2
does per-envelope signature work related to neither. An honest model names the terms:

```
base
+ decode/authenticate(program, witness_bytes, records)
+ reconcile(E log E)
+ graph_build(V, E)
+ iterations_run * rank(V, E)
+ output_and_merkle(V)
```

**And "within a small factor" is the wrong shape of guarantee for an admission guard.** A guard
must never fall *below* actual cycles inside the supported envelope; erring low is a correctness
failure, not an imprecision. Two-sided accuracy is a pricing goal with a different consumer.

### The size bound is expressed in the wrong unit

`TrustgraphsParamsValidator` caps iterations at 500, seeds at 64, and weights at 1e6. The only
bound on how big a graph may get is `MAX_PRICED_INPUTS`, which counts attestations, and nothing
anywhere counts accounts. Since the cost is driven by accounts, the bound does not constrain the
thing that costs money.

There is also no bound the guest itself asserts. The bound lives entirely in an off-chain
operator policy and an on-chain fee schedule, both of which can be reconfigured, and neither of
which the proof commits to.

The failure mode is honest, at least. Too large a graph means no proof gets produced, so the
snapshot stalls rather than committing something wrong. But "the network silently stops updating
when it gets popular" is not an acceptable production characteristic, and today the only thing
that tells an operator a graph has gotten too big is the bill.

### The shipped configuration never settles

The reference vector runs all 100 iterations and stops because it hit the ceiling, not because
the numbers stopped moving. This was in the earlier review. It is worth restating here because
it is also a performance fact: iterations you did not need are cycles you paid for.

A 120 account graph, five vouches each, given a 500 iteration budget:

| boost | iterations to settle | settled? |
|---|---|---|
| 1.0 | 23 | yes |
| 2.0 (as shipped) | 33 | yes |
| 4.0 | 82 | yes |
| 10.0 | 500 | **no** |
| any of the above, with the denominator corrected | 23 | yes |

That last row is the important one. The boost breaks convergence because it multiplies what a
founding account sends out without changing the total it divides by, so a founder's vouches sum
to more than the founder holds and the excess compounds. Include the boost in that total and it
cancels: **we measured the corrected version to be bit-for-bit identical at 1x, 2x, 4x, and
10x**, and the iteration count stopped depending on the setting entirely. (At 1.5x the results
differ in the last few digits, because multiplying a whole-number weight by 1.5 rounds. The
setting is inert up to that rounding, not merely approximately inert.)

The setting stops doing anything at all, which is the honest state of affairs.

There is a second prize here. Once every account's vouches sum to at most what the account holds,
total standing can never grow, which means the whole class of "this configuration is unprovable"
disappears: `MAX_RANK_FP`, `_validateGrowth`, `RankGrowthUnbounded`, and the overflow panic in
`mul_div` all exist to catch a runaway that can no longer happen. That is a Solidity loop, a
Rust panic, and a documented failure mode all deleted by one correction to a denominator.

### The rounded iteration can cycle instead of settling (F3)

The stopping rule assumes the iteration approaches a fixed point. A contraction argument for
real-valued PageRank does not carry to the truncating integer map, and it turns out not to hold.
Replicating the production loop and recording the full state each round, at parameters the
validator accepts today (tolerance = 1 fixed-point unit, decay 1.0):

| graph | damping 0.85 (the shipped value) | damping 0.99 |
|---|---|---|
| 2-cycle | **limit cycle, period 2** | **limit cycle, period 2** |
| 3-cycle | **limit cycle, period 3** | **limit cycle, period 3** |
| uneven-weight 4-ring | **limit cycle, period 4** | **limit cycle, period 4** |
| path of 6 | settles in 7 | settles in 7 |
| 4-cycle + chord | settles in 180 | settles in 544 |

This is not an adversarial corner: it happens at the shipped damping on any periodic graph.

The amplitude, however, is last-bit dust. Residual movement in the cycle is 0 to 6 fixed-point
units, around `1e-18` of the scale, and it does not grow with the graph:

| V | out-degree | residual movement |
|---|---|---|
| 10 | 3 | 2 units |
| 50 | 3 / 10 | 0 units |
| 200 | 6 / 20 | 2 / 0 units |
| 800 | 6 / 20 | 6 / 1 units |
| 2,000 | 6 | 5 units |

Running 500, 501 and 502 iterations on a cycling graph moved scores by 0.0000 percentage points.

So the defect is real and the remedy is small. `TrustgraphsParamsValidator` bounds tolerance from
above (`MAX_TOLERANCE_FP`) and only requires it to be nonzero below, which is how the regime is
reachable at all. A floor around `1e6` units sits six orders above anything measured and six below
the shipped `S/1e6`. The alternative, a guest that refuses an unconverged result, reintroduces the
failure mode Release 2 exists to delete: a governed parameter change that makes an instance
unprovable.

**Stated carefully, because an earlier draft did not.** A finite sweep over the topologies above is
"not observed", not "proved". A crafted graph could accumulate truncation differently, and Release
4 changes the transition map anyway. `MIN_TOLERANCE_FP` is an empirically motivated product floor
that keeps networks out of a regime where the stopping rule measures dust; it is not a no-cycle
theorem, and under fixed-iteration semantics correctness does not need one.

### A configured seed with no edges silently loses its endowment (F8)

`reconcile::build_graph` builds the node set from live edge endpoints only, while
`initialize_scores` divides the trusted share by the count of **configured** seeds. A seed with no
edges in either direction is never in the node set, never receives its slice, and the slice is not
redistributed. Measured at a starting share of 100%:

| configured seeds | present in the graph | initial mass actually granted |
|---|---|---|
| one, present | 1 of 1 | 100.000% of the scale |
| two, one absent | 1 of 2 | **50.000%** |
| three, two absent | 1 of 3 | **33.333%** |

The teleport term re-grants that deficient vector every round, so the shortfall is structural
rather than transient. The final normalisation rescales whatever survives, which is why nobody has
noticed. It means the endowment a network configured is not the endowment it got, and the error is
largest exactly when a founder has not yet vouched or been vouched for, which is genesis.

Closing the admission gate makes this worse, not better: once the whole endowment sits with the
seeds, a lost seed share stops being a rounding concern.

### Hoisting the decay factor is not enough on deep graphs (F1)

`decay_pow` walks `distance` multiplications. Computing it once per node instead of once per
recipient per iteration is a large improvement, but it is still quadratic on a path graph whose
distances run `0..V-1`. Carrying the factor along the BFS frontier
(`decay[child] = fp_mul(decay[parent], base)`) is bit-identical by construction, because BFS
assigns the child a distance exactly one greater and the fold from the scale is the same sequence
of multiplies:

| V | per-node `decay_pow` | carried along BFS | speedup | identical? |
|---|---|---|---|---|
| 600 | 15.14ms | 0.61ms | 25x | **yes** |
| 4,000 | 674.56ms | 5.50ms | **123x** | **yes** |

### The documentation describes a mechanism that does not work that way

`docs/concepts/algorithm.md` lists "Attestation Weight Multiplier: trusted attestor endorsements
receive weight W_trust > 1" as one of three trust mechanisms. It is not a trust mechanism. It
dilutes the founder, leaves every downstream ratio exactly unchanged, and breaks convergence.

The same document's formula, `PR(i) = (1-d) T(i) + d * sum(PR(j) W(j,i) / L(j))` with
`L(j)` = "total outgoing attestation weight from j", already describes the corrected behaviour.
The fix makes the code match the document that was there all along.

## What the earlier review found, still open

Condensed. The measurements and the reasoning are in
[`SCORING_NEXT_STEPS.md`](./SCORING_NEXT_STEPS.md); each was re-confirmed this pass against the
production Rust rather than the Python model.

- **The admission gate leaks unless one setting is exactly right.** With 40 real members and 160
  fabricated accounts, the fabricated bloc holds **32.3%** of all standing at the shipped
  settings. The reference vectors, the example deployment script, and the shared parameter file
  are all at 15%.
- **Fixing the boost on its own makes it worse.** Same graph, boost removed and nothing else:
  **44.5%**. The two defects have been partly cancelling each other. They are one change.
- **A reachability gate closes it absolutely, at any setting.** Deny the leftover starting
  balance to accounts no trusted path reaches and the fabricated bloc holds **0.00%**, at a 15%
  starting share as readily as at 100%. That is what turns the setting into a safety belt
  instead of the only defence.
- Founders hold an unremovable floor. Vouching costs you unless it is reciprocated. Closed loops
  pay and headcount does not. The score has no clock, and a dead account's signature keeps
  getting re-installed on the Safe.
- Complaints, and the withheld share that makes punishing someone cost something.

## What "production ready" means here

Eight properties. This is the checklist the plan is built to satisfy, with where we stand today.

| | property | today |
|---|---|---|
| 1 | Cost is linear in attestations per iteration | no, quadratic in accounts |
| 2 | Cost is predictable before proving | no, the model has the wrong shape |
| 3 | Total standing is conserved exactly, every iteration | no, it grows and is normalised once at the end |
| 4 | Terminates for a stated reason, with a stated bound | no, the shipped config exhausts its iterations |
| 5 | No parameters the validator accepts can make the guest panic | yes, but by a Solidity heuristic rather than by construction |
| 6 | An account no trusted path reaches has no standing | only when one setting is exactly 100% |
| 7 | One implementation, one set of semantics | no, four |
| 8 | Cross-language agreement enforced by construction | no, by seven fixed reference vectors |

## The plan

Five releases. Each one states what changes, what proves it, and what it breaks.

Ordering principle: **changes that provably do not move anyone's score go first and separately**,
so they can be verified mechanically. Changes that do move scores are batched by the dependency
between them, not by convenience.

---

### Release 0: clear the desk

Independent of everything else. Nothing here changes a score, a vector, or a key. Doing it first
makes every later diff readable.

The full list is in [the cleanup ledger](#the-cleanup-ledger) below. In summary: delete the dead
ERC-8004 reputation crate and its unread reference vector, retire the floating-point crate to a
test fixture, remove a stray build profile that makes cargo warn on every workspace command, and
fix seven source files that cite a specification file which does not exist.

One repair belongs here too, because it touches neither the algorithm nor the encoding and it is
in the script we would deploy a testnet with. **Split the timelock roles.**
`contracts/script/DeployTimelocks.s.sol` takes a single `proposerAddr` and uses it for both
tiers, and line 82 comments the zero admin as "no admin: roles are fixed to (proposer, executor)
at deploy". Passing zero does correctly disable the optional external admin, but the rest of that
sentence is not true of OpenZeppelin 5.4.0: the constructor grants `DEFAULT_ADMIN_ROLE` to the
timelock itself unconditionally, and grants `CANCELLER_ROLE` to every proposer. So the roles are
not fixed, they are administered by the timelock through its own delay, and the single proposer
address can also veto. One party ends up able to block every proposal, including the proposal
that would remove them.

**Done when** the only warning left from `cargo check --workspace` is the transitive
`proc-macro-error2` future-incompatibility notice (today there are two, and the other one is
ours), no file references a missing document, every crate in `crates/` has at least one consumer,
and a hostile single proposer can no longer veto its own removal.

---

### Release 1: the engine, with the numbers unchanged

Turn the loop inside out. Hoist the per-account totals out of the iteration. Change nothing else.

- `crates/pagerank-core/src/pagerank.rs`: push instead of pull, precompute each account's
  outgoing ratios and decay factor once.
- `packages/frontend/lib/pagerank/pagerank.ts`: the same change, or the browser preview stays
  quadratic and hangs a tab on any real network.
- `crates/operator-core/src/types.rs`: the cost model becomes correct, since after this change
  the work really is linear in attestations.
- Assert that every account named by a vouch is in the node set, in all five programs.
- Add the property tests the core does not have: determinism under input permutation, the node
  set is closed under the edges, total standing after normalisation is exactly the scale, and
  the loop reaches its stopping condition. `crates/weighted-prior-core/tests/properties.rs` is
  the model to copy.

**Done when** all seven reference vectors are byte-identical, `guest == native` passes on every
program, the executor's measured cycles for a 200-account graph land within a small factor of
`estimated_cycles` instead of 54x above it, and the new cycle table is published in the runbook.

**Breaks:** the guest binary changes, so the verification key changes and instances need
`setZkVerifier`. Nothing else. This is the ideal change to rehearse that rollout with, precisely
because "did it work?" has a mechanical answer.

**Do not merge this with Release 2.** The entire value of this release is that its correctness
argument is "the output is identical", and that argument does not survive being bundled with a
change that alters the output.

---

### Release 2: close the gate

One atomic change, because its parts cancel each other if separated. This is the release that
matters for safety.

- Starting share to 100% in the reference vectors, `params.contributions.json`,
  `contracts/script/examples/CreateInstance.s.sol:58`, and
  `contracts/script/DeployEasOffchainE2E.s.sol:82`. The creation wizard already defaults to 100%
  and warns twice; it is the templates that are wrong.
- The leftover starting balance goes only to accounts a trusted path reaches. About five lines,
  mirrored in TypeScript.
- Fold the founder boost into the row denominator, which makes it provably inert, and then
  **remove it from the parameter tuple entirely.** The field appears in four parameter tuples
  (`ParamsCodec`, `ContributionsParamsCodec`, `HypercertsParamsCodec`,
  `NostrWorkspaceParamsCodec`) across five programs, and 103 files mention it. That is a real
  day of work and it costs nothing else today. It will not be free again.
- With growth impossible, delete `_validateGrowth`, `RankGrowthUnbounded`,
  `MAX_TRUST_MULTIPLIER_FP`, and the growth section of `docs/build/create-a-network.md`. Replace
  the `mul_div` overflow panic's justification with an invariant the guest asserts directly:
  total standing never exceeds the scale, checked every iteration.
- Templates get three to five founding accounts instead of one.
- Raise the governance quorum default from 4%.
- Correct `docs/concepts/algorithm.md`.

**Done when** a 160-account fabricated bloc holds 0.00% at every starting share the validator
accepts, the reference vectors settle on their stopping condition rather than exhausting their
iterations, and no parameters the validator accepts can panic the guest.

**Breaks:** all seven reference vectors, the parameter encoding, the parameter hash, and the
verification key. Everything downstream of the parameter tuple: the codecs, the validators, the
frontend parameter forms, the indexer, and the deployment scripts.

---

### Release 3: earn the endowment, and the remaining repairs

Independent of each other; grouped because none of them is large. (The timelock role split
started here and moved to Release 0, since it touches neither the algorithm nor the encoding and
it is in the script a testnet deploy would use.)

- **The founders' starting balance becomes conditional on being vouched for.** Configuration says
  who *may* hold it, the graph says who does. The fallback rule is load-bearing and easy to get
  wrong: when no founder has been vouched for yet, the balance stays with the configured
  founders. It must never fall back to spreading evenly, which reopens the gate on day one and
  hands a fabricated bloc 93.9%.
- **Give the signer sync a liveness input of its own.** No scoring change can fix the dead-signer
  deadlock, because the problem is that a score cannot know its holder stopped acting.
- **Weight vouches by how long they have stood.** Timestamps are already ordered by consensus.
- Publish the distance-decay trade-off table next to the setting in the creation flow, so the
  choice between "trust travels far" and "closed loops pay less" is made with the numbers in view.

**Done when** a founder nobody vouches for ranks last rather than first, and a fresh network with
no vouches yet still refuses a fabricated bloc.

---

### Release 4: one core

Replace the shared loop with the shape `weighted-prior-core` already uses, generalised over the
node key and extended with the prior and the decay term the trust graph needs. Then
`weighted-prior-core::rank` becomes a caller rather than a second implementation.

What this buys, beyond deleting 500 lines:

- **Exact whole-number apportionment.** Every iteration distributes precisely the standing it was
  given, with the remainder assigned by largest remainder and ties broken by address. No drift,
  no final renormalisation.
- **A denominator that exists.** Today the divisor is "whatever the scores happened to sum to at
  the end". Making it the scale by construction is what the withheld share in Release 5 needs to
  be meaningful, and it is why Release 5 cannot come first.
- **One set of semantics for five programs.** Every fix, every test, and every audit applies once.

Also worth deciding here: whether the browser keeps a hand-written port. Compiling the core to
WebAssembly removes an entire category of bug that seven fixed reference vectors can only sample
for. It costs a build step and a bundle. If we keep the hand port, the cheap mitigation is
differential fuzzing between the Rust and the TypeScript in CI, which is worth doing either way.

**Breaks:** the reference vectors and the verification keys again, for all five programs.

---

### Release 5: complaints

The design, the measurements on real data, and the honest limits are in
[`SCORING_NEXT_STEPS.md`](./SCORING_NEXT_STEPS.md#complaints-letting-the-graph-say-that-something-went-wrong).
In outline: a complaint is a new attestation kind whose force is its author's standing, it
discounts trust flowing into its target rather than propagating, it never drives a score
negative, and the standing it removes goes into a withheld share that counts in the denominator
and is simply not paid out. Complaint weight is a per-network setting with a validator cap, and
zero is a real setting that reproduces today's behaviour exactly, which is the migration path.

One thing still needs deciding before any of it is built: **the recovery path.** Someone wrongly
accused and someone guilty who talked their way back produce identical graphs, and anything that
makes a bad reputation expensive to shed makes a false accusation equally expensive to escape.
Decaying with sustained re-endorsement is more honest than decaying with time, but it is a
decision, not a detail.

---

## The cleanup ledger

Every item is independent and none of them changes a score.

| What | Why | Action |
|---|---|---|
| `crates/graph-reputation-core` (725 lines) | no dependents anywhere. An ERC-8004 spike that got promoted into the production workspace during the reorg | move to `research/`, or delete |
| `tests/golden/graph-reputation.json` | nothing reads it. A reference vector with no test is a file that can silently rot | delete with the crate |
| `docs/build/graph-reputation/*` | documents a program that does not exist as if it ships | delete, or mark clearly as research |
| `crates/pagerank` (1,132 lines) | the original floating-point implementation, reachable only from one development example | keep the example, move the crate under `research/`, or fold the fixture into the test module |
| `crates/pagerank/Cargo.toml:29` | a `[profile.release]` section in a non-root crate, which makes cargo print a warning on **every** workspace command | delete |
| `PLAN.md` references | seven files cite it as the specification of record, including the header of `pagerank-core`. It does not exist | point at the real documents, or write the missing one |
| `docs/concepts/algorithm.md` | describes the founder boost as a trust mechanism | correct with Release 2 |
| `crates/weighted-prior-research` (351 lines) | one consumer, `zk/prover`. Legitimate, but the name says research and the location says production | confirm it belongs in `crates/`, or move it |
| `research/` build artifacts | 3.9 GB of untracked `target/` output under `research/eas-offchain`, `research/erc8004-completeness`, and `research/weighted-priors`. Not committed, but it makes the tree slow to search | add to `.gitignore` and a clean task |
| rank core test coverage | three tests touch the ranking itself. `weighted-prior-core` has property, validation, and golden suites | fill in with Release 1 |

## What this plan does not fix

Stated plainly so nobody rediscovers them.

- **Closed loops still pay.** A fabricated account is somewhere your outflow lands that you still
  control, and a vouch back makes it a loop. The gain is flat in headcount, so no defence that
  counts identities touches it. Distance decay bounds it and nothing else does. This is the most
  interesting open research question in the system.
- **Complaints will protect insiders and not strangers.** The property that makes them resistant
  to fabricated accounts is the same property that makes them blind to someone who only ever
  defrauds newcomers. We do not think you can have one without the other, and it needs saying in
  the product rather than in a research document.
- **A correct minority stays unrepresentable.** The score aggregates agreement. Being early and
  right looks exactly like being wrong.
- **The optimal attack size is public**, because the scoreboard is published and its integrity is
  proven. That is inherent to verifiability. It means defences have to be structural, since
  anything statistical is being published against.

## How to check any of this

The performance and parity measurements come from driving `pagerank_core::pagerank` directly and
comparing against a candidate rewrite over the same inputs, including the exact graph and
parameters in the shipped reference vector.

```sh
# guest cycles for the shipped reference vector, and for any input you like
cd zk/prover && cargo run --release -- trust-graph execute [input.json]

# the reference vectors, all seven. Baseline today: 60 suites, 343 tests, 0 failures
cargo test --workspace
task test

# the earlier review's model, which reproduces the shipped payouts exactly
cd research/scoring-sim && python3 tg.py
```

`research/scoring-sim/` holds the model from the earlier review, which reproduces the shipped
reference vector's payouts digit for digit and is where the sybil, complaint, and withheld-share
numbers came from.
