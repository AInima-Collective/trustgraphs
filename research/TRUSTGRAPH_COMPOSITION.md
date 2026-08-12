# TrustGraph Composition

**Status:** research report, 2026-08-12. Design recommendation; no implementation decision yet.
**Question:** how should a user combine trust graphs A, B, and C into one scored graph, and what would it mean for graphs themselves to earn reputation and vouch for other graphs?

---

## Executive summary

TrustGraph should treat composition as a family of different operators, not one feature hidden
behind a single “combine” button. The stated user story has a simple, rigorous first answer:

> Normalize each source's published allocation into a probability distribution, combine those
> distributions with explicit weights, then apportion the composite's point pool under one
> deterministic, source-aware rounding rule.

For source graph \(g\), account \(x\), published value \(v_g(x)\), published total
\(T_g\), and configured source weight \(\alpha_g\):

\[
p_g(x)=\frac{v_g(x)}{T_g},\qquad
q(x)=\sum_g \alpha_g p_g(x),\qquad
\sum_g\alpha_g=1.
\]

In ideal arithmetic this is a convex blend of finalized score distributions. It is the best first release because it is
deterministic, explainable, attribution-friendly, compatible with the existing address/value
Merkle output, and gives each source a governable maximum influence. It must normalize by
`totalValue`; averaging raw published points would accidentally give more influence to graphs that
chose larger point pools.

“A trust graph for trust graphs” is promising, but it solves a different problem: **which sources
should be admitted and how much influence should each receive?** It should be a separate,
scope-specific meta-reputation layer. Graph authorities can make typed, expiring endorsements of
other graph lineages. A personalized, damped reputation calculation can then adjust—or propose—the
weights used by the distribution blend. It cannot remove the need for an initial root of trust,
Sybil-resistant admission, caps on related graph families, or human governance.

The recommended sequence is therefore:

1. Ship an explicit weighted score-distribution composer with complete provenance and per-account
   attribution.
2. Make every source reference immutable at the composite checkpoint and verify each complete
   source blob against its accepted onchain root.
3. Introduce graph identity, typed endorsements, and scoped meta-reputation as an optional policy
   for deriving source weights—not as an oracle of universal truth.
4. Explore edge-level multiplex ranking, imported priors, robust statistics, and subjective-logic
   fusion as separate programs with deliberately different semantics.

The key product principle is: **prove adherence to an explicit composition policy, while making no
claim that the policy itself is wise or that a score is objective truth.**

## 1. What exactly is being composed?

The word “graph” currently collapses several distinct objects:

| Object | Stable for | Example use |
|---|---|---|
| Graph lineage | The continuing community/network identity | “Octant reputation” |
| Program and configuration | One scoring method and parameter version | PageRank parameters and vkey |
| Epoch/source state | One immutable cutoff and accepted output | Root at freeze block 19,000,000 |
| Score distribution | Address → relative allocation for that epoch | Alice 60%, Bob 40% |
| Raw relation graph | Attestations/edges before scoring | Alice vouches for Bob |

Composition must say which of these it consumes. Combining raw edges, PageRank priors, and final
score distributions yields different results even with the same A, B, and C. A composition must
also declare:

- **output kind:** allocation, probability, eligibility, rating, or some other unit;
- **subject identity domain:** same-chain EVM addresses initially, or an explicit cross-domain
  identity binding;
- **scope:** what the score claims to be useful for;
- **epoch policy:** which source state is selected and how stale it may be;
- **operator:** weighted blend, prior injection, edge multiplex, sequential weighting, or evidence
  fusion;
- **provenance and trust boundary:** exact source states plus any version/method facts that are
  cryptographically bound versus governance-admitted.

Two outputs sharing the same `(address, value)` leaf shape are not automatically semantically
compatible. A contribution payout, an interpersonal trust score, and an anti-fraud probability
must not be blended merely because all three contain addresses and integers.

TrustGraph already makes the important architectural distinction between a **program**, which
fixes semantics and proof logic, and an **instance**, which deploys those semantics with a
particular configuration. A new composition rule should therefore be a new program, not an
unlabelled behavior change to existing instances ([program model](../docs/concepts/networks-and-programs.md)).

## 2. Composition is not one operator

| Operator | Meaning | Cross-source interaction | Best use | Recommendation |
|---|---|---:|---|---|
| **Final-distribution blend** | “A gets 33%, B 33%, C 34% of the final voice” | None | The stated user story; ensembles; plural governance | Build first |
| **Raw-edge union** | Put all attestations in one graph and rank once | Full | Sources use identical edge semantics and conflict rules | Do not call this score composition |
| **Multiplex ranking** | Preserve A/B/C as layers while ranking nodes and perhaps layers together | Full | Cross-community path effects are desired | Research later |
| **Prior injection** | A/B/C provide the teleport/start distribution for a destination graph | Imported standing propagates through destination edges | Bootstrapping and inherited trust | Pursue via [graph seeding](GRAPH_SEEDING.md) |
| **Sequential composition** | A scores evaluators; their ratings in B determine C | Directional and task-specific | Contribution funding, curation, oracle panels | Already has a precedent |
| **Robust/agreement pool** | Quorum, veto, median, trimming, or geometric pooling | Rewards agreement or limits outliers | Security and eligibility decisions | A separate operator, not a transform |
| **Evidence/opinion fusion** | Combine beliefs, disbelief, and uncertainty | Depends on declared evidence independence | Claims with calibrated uncertainty | Research only after the score type supports it |

These operators answer different questions:

- A final blend asks, “How much decision weight does each community receive?”
- An edge or multiplex composition asks, “What new paths exist when communities interact?”
- Prior injection asks, “Whose standing should bootstrap influence in this destination graph?”
- Sequential composition asks, “Whose judgment should weight a different kind of record?”

TrustGraph already contains examples adjacent to three of them:

- The two accumulator lanes are merged into **one raw edge set** before reconciliation and one
  PageRank run ([compute.rs](../packages/pagerank-core/src/compute.rs)). Because raw edges have no
  source identifier and repeated attester/recipient pairs use last-write-wins reconciliation, this
  is not an A/B/C score blend ([reconcile.rs](../packages/pagerank-core/src/reconcile.rs)).
- Contributions **recomputes reputation and uses it to weight evaluations**, a directional,
  application-specific composition ([contributions architecture](../docs/build/contributions/architecture.md)).
- The graph-seeding report proposes using external score distributions as **continuous teleport
  priors**, so imported standing propagates through a destination graph's edges
  ([GRAPH_SEEDING.md](GRAPH_SEEDING.md)).

Keeping these names distinct is important. A user who chooses “33% A” should not receive a result
where an A-ranked account gains much more than 33% influence because its outgoing relationships
were propagated through B and C.

## 3. Current score semantics constrain a correct blend

### 3.1 A published TrustGraph score is a relative allocation

The rank core first computes a fixed-point normalized PageRank-like distribution
([pagerank.rs](../packages/pagerank-core/src/pagerank.rs)). The distribution step then:

1. floors every normalized score to a `1e6` quantum, retaining zero-scaled entries in its working
   list;
2. divides an instance-local `total_pool` in proportion to the quantized total;
3. assigns all remaining integer points to the last sorted entry.

The last entry may itself have zero quantized mass. If so, it can receive a positive remainder
while other sub-quantum accounts disappear. The address/value blob therefore exposes the program's
published allocation, including this legacy rounding artifact—not the raw rank support.

See [distribute.rs](../packages/pagerank-core/src/distribute.rs). The canonical public artifact is
only the positive address/value map ([cid.rs](../packages/zk-core/src/cid.rs)), committed by an
address/value Merkle tree ([merkle.rs](../packages/zk-core/src/merkle.rs)).

Consequences:

- Scores from two instances do not share an absolute unit. A score of 100,000 may mean 10% in one
  graph and 0.1% in another.
- A source's `total_pool` must not become an accidental source weight.
- A baseline composer consumes the **published, quantized allocation**, not the source's hidden
  pre-distribution PageRank values.
- An absent address, a true zero, and most positive values lost below the source's quantization
  threshold are indistinguishable in the current public blob; one zero-quantized entry may survive
  as the remainder recipient.

The first of these makes source normalization mandatory. The last makes honest coverage language
mandatory: today the system can report “present in the source's positive output,” not “evaluated by
the source.”

### 3.2 Recommended baseline formula

Let:

- \(G\) be a finite, canonically ordered set of source graph states;
- \(v_g(x)\) be source \(g\)'s published integer allocation for account \(x\), or zero if absent;
- \(T_g=\sum_xv_g(x)\), taken from and checked against the source's proven `totalValue`;
- \(\alpha_g\ge0\) be an integer policy weight with \(\sum_g\alpha_g=S\), and
  \(a_g=\alpha_g/S\) its normalized weight;
- \(P\) be the composite instance's output pool.

Compute a high-precision mass:

\[
q(x)=\sum_{g\in G}a_g\frac{v_g(x)}{T_g}.
\]

That formula is the ideal rational policy, not yet an executable consensus specification. The
order and rounding of `alpha * value / (S * total)` matter. A naive floor per source loses mass and
makes implementations disagree about residual points.

A strong baseline candidate is **source-aware largest-remainder apportionment**:

1. Allocate \(P\) integer points among sources in proportion to \(\alpha_g/S\). Floor every source
   quota, then award residual points by descending fractional remainder, tie-broken by canonical
   source ID. Call the exact resulting quota \(P_g\).
2. Within each source, allocate \(P_g\) among its published accounts in proportion to
   \(v_g(x)/T_g\), again using floor plus descending remainder and address tie-break.
3. Sum each account's integer allocations across sources and publish the standard address/value
   output.

This approximates the rational blend at the composite point quantum while conserving the entire
pool, makes the integer contribution of every source explicit, and exactly reproduces a 100%
source when \(P=T_g\). It applies no second `1e6` score quantization. Its tradeoff is that a source
whose weight is smaller than one composite point may receive zero, and largest-remainder methods
have known non-monotonic behavior as the total pool changes. Phase 0 should compare this with a
single high-precision mass-grid method before golden-locking one.

Whichever wins must specify operand order, flooring direction, intermediate width and overflow
bounds, maximum sources and entries, residual ordering, and error bounds. “Use widened integers”
is not a sufficient consensus rule.

For the product example, suppose:

| Source | Alice | Bob | Carol | Weight |
|---|---:|---:|---:|---:|
| A | 60% | 40% | 0% | 33.3% |
| B | 0% | 50% | 50% | 33.3% |
| C | 20% | 0% | 80% | 33.4% |
| **Composite** | **26.66%** | **29.97%** | **43.37%** | **100%** |

At a composite pool of 1,000,000 points, this idealized example yields 266,600, 299,700, and
433,700 points before any implementation-specific precision edge case.

### 3.3 Required semantics

**Missing account.** An absent address contributes zero from that source. Do not renormalize source
weights separately for every account: doing so rewards sparse graphs, makes the meaning of 33%
person-dependent, and destroys global mass conservation. Zero contribution means “this source
allocated none of its finite voice here,” not negative trust or proof that the account was
evaluated.

**Empty source.** A required source with `totalValue == 0`, an unavailable blob, or an invalid root
must not produce a composite result; a trigger preflight should avoid freezing a checkpoint that
cannot be proven. Silently redistributing its weight changes the declared policy. An “optional
source” mode can exist later, but its fallback and effective weights must be committed and
displayed.

**Source universe.** The computation's candidate universe is the union of all positive entries in
complete validated source blobs; final integer apportionment can still leave a tiny candidate with
zero published points. Membership proofs for selected accounts are insufficient: a prover could
omit competitors while still presenting valid leaves.

**Weight precision.** Store nonnegative integer weights that sum exactly to a declared scale, such
as `1e18` or 10,000 basis points. Reject duplicate sources and ambiguous rounding.

**Source transforms.** No log, rank, percentile, temperature, activity, node-count, or confidence
transform in the baseline. Each is a substantive policy that can reward splitting or change the
meaning of a source. If introduced, give it a versioned adapter ID and commit it in the composition
parameters.

**Compatibility.** Start with same-chain, address-keyed, allocation-valued TrustGraph sources of a
declared compatible scope. Broader source types require explicit adapters, not duck typing based on
leaf length.

### 3.4 Useful guarantees

The ideal rational blend provides unusually legible guarantees:

- **Conservation:** \(\sum_xq(x)=1\) when every source is valid and normalized.
- **Source cap:** source \(g\)'s total contribution is exactly \(a_g\).
- **Bounded replacement:** replacing all of source \(g\)'s output changes any account by at most
  \(a_g\), and changes the distribution's L1 distance by at most \(2a_g\).
- **Commutativity:** reordering sources cannot change the result.
- **Monotonicity:** holding all else fixed, increasing \(v_g(x)\) relative to that source's other
  accounts cannot decrease \(x\)'s ideal composite mass.
- **Attribution:** \(a_gp_g(x)\) is the exact ideal contribution of source \(g\) to account \(x\).

The consensus apportionment must state which survive exactly and which hold within a point-sized
error bound. The source-aware candidate makes integer source quotas and total conservation exact;
its account allocations approximate the ideal blend and can exhibit boundary effects.

These are valuable product properties, not just mathematical niceties. They let the UI explain a
score and let governance cap the damage from a compromised source.

Weighted sums are associative in exact arithmetic, but composite-of-composite inputs should still
be excluded from the initial version. Quantization, duplicated ancestry, and correlation make a
nested 50% composite that already contains A very different from an atomic 50% source. A later
version can flatten a canonical lineage manifest to atomic source weights, reject duplicates and
cycles, and apply one round of quantization.

### 3.5 What the blend does not claim

The blended result is a plural allocation of voice. It is not proof that:

- the sources measure the same latent truth;
- the inputs are independent;
- a 0.8 value represents an 80% probability;
- agreement between two cloned or correlated graphs is two independent observations;
- the configured weights are fair.

When the output will distribute money or governance power, the system should show those limits
alongside its cryptographic guarantees.

## 4. Graphs vouching for graphs

### 4.1 What graph reputation should do

A graph meta-layer should answer a scoped source-policy question:

> Starting from the composer's chosen roots of trust, which graph lineages are credible for this
> purpose, and what influence should they receive?

It should not produce one universal league table of “best trust graphs.” Reliability is
purpose-dependent: a graph may be well governed and excellent for open-source contribution while
being irrelevant to credit, art curation, or personhood.

This is closely analogous to EigenTrust's normalized local opinions, damped global reputation, and
explicit pretrusted peers. Its authors introduced pretrusted peers specifically to anchor the
calculation against malicious collectives ([EigenTrust paper](https://nlp.stanford.edu/pubs/eigentrust.pdf)).
TrustRank likewise propagates trust from selected seeds with attenuation
([TrustRank paper](https://snap.stanford.edu/class/cs224w-readings/gyongyi04trustrank.pdf)). Neither
construction makes roots of trust disappear; it makes their downstream consequences explicit and
computable.

### 4.2 Give a graph a real identity before giving it reputation

A Merkle root is an epoch, not an enduring actor. A snapshot contract is not necessarily an entity
that can sign. Graph identity should have three layers:

1. **Lineage identity:** qualified chain, registry, instance lineage, and authenticated governance
   authority or publisher.
2. **Configuration identity:** program/vkey, scoring method, scope, identity domain, parameters,
   controller history, and source lineage policy.
3. **Epoch identity:** exact checkpoint, freeze block, output root, blob digest/CID, and
   `totalValue`.

Endorsements should be issued by the lineage's authenticated authority—such as its controller or
Safe—not fictionally “by” an output root. An endorsement must state whether it follows compatible
upgrades or is pinned to a specific configuration range.

### 4.3 Endorsements need types, scope, and expiry

“A vouches for B” is underspecified. At minimum, keep these claims separate:

- **identity/integrity:** “B is operated by the named organization and publishes what it says”;
- **methodology:** “B's method is appropriate for scope S”;
- **referral/delegation:** “for scope S, I permit B to introduce other sources”;
- **snapshot agreement:** “my current result agrees with B's specified epoch.”

Only an explicit referral should propagate reputation. A methodology endorsement should not
silently turn B into an introducer. OpenPGP's surrounding certification framework is useful
precedent: Trust Signatures encode amount and propagation depth, while separate mechanisms add
User-ID regular-expression constraints and certification revocation
([RFC 9580 §§5.2.3.20–22](https://www.rfc-editor.org/rfc/rfc9580.html#section-5.2.3.20)). Those
regular expressions scope identity certification, not arbitrary application semantics; TrustGraph
still needs its own `scopeHash` vocabulary.
Score similarity may be displayed as evidence, but it must not create a vouch edge automatically;
copies would otherwise endorse one another by construction.

A minimal conceptual record is:

```text
GraphVouch {
  issuerLineage
  subjectLineage
  subjectVersionConstraint
  scopeHash
  kind                    // integrity | methodology | referral | agreement
  weight                  // spends issuer's bounded outgoing endorsement budget
  validFrom
  validUntil
  evidenceURI
  sequenceOrRevocationRef
}
```

Outgoing referral weights should be normalized or budgeted, so creating more endorsements cannot
create influence from nothing. The stationary calculation below propagates to unbounded depth; it
must not expose an unenforced depth field. A future finite-horizon walk could support explicit
delegation depth by carrying remaining depth in its state.

The baseline meta-graph is positive-only. Negative endorsements should not enter the recurrence as
negative transitive trust: distrust is not simply the mirror image of referral. A negative record
may inform eligibility, a warning, or a separate non-propagating risk signal, but should not create
negative reputation edges in this program.

### 4.4 A defensible first meta-reputation calculation

For one scope, let \(V_{ij}\) be the fraction of graph lineage \(i\)'s referral budget assigned to
\(j\), let \(p\) be the composer's sparse root-of-trust distribution, and let \(\lambda<1\) be a
damping factor. Every non-dangling row of \(V\) must sum to one; route dangling or explicitly
unspent budget back to \(p\). Then solve:

\[
r=(1-\lambda)p+\lambda V^\top r.
\]

This gives a scoped, personalized, epoch-versioned graph reputation \(r\). There should be no
uniform prior over every registered graph: when graph creation is cheap, a uniform prior is a
Sybil subsidy. Douceur showed that, without a logically centralized identity authority, generally
preventing Sybils requires strong resource-parity and coordination assumptions. A stake or fee
therefore only prices attacks under an explicit adversary-budget model; graph-of-graphs math does
not create identity uniqueness
([The Sybil Attack](https://www.microsoft.com/en-us/research/publication/the-sybil-attack/)).

Two sensible ways to use \(r\) are:

1. **Advisory:** rank candidate sources and ask governance to set explicit \(\alpha\). This is the
   safest first product.
2. **Bounded automatic adjustment:** for eligible set \(E\), first restrict and renormalize
   \(r_E(g)=r(g)/\sum_{h\in E}r(h)\), falling back to \(b\) if eligible reputation is zero. Then
   combine a normalized manual allocation \(b\), for example
   \(\alpha=(1-\beta)b+\beta r_E\). Per-source and publisher-family caps require a deterministic
   capped-simplex redistribution—not simple clipping—or weights will no longer sum to one. The UI
   must display `base weight`, `reputation adjustment`, and `effective weight` separately.

A multiplicative policy \(\alpha_g\propto b_gf(r_g)\) is also possible, but it makes weak or new
sources vanish and is harder to explain. It should not be the default.

### 4.5 Cycles, cartels, and graph families

A closed mutual-vouch clique disconnected from the personalized prior receives no stationary mass.
That is useful, but incomplete. A single trusted ingress can still feed a cartel, and ten cloned
graphs can appear to provide ten confirmations of the same evidence.

Protections should include:

- admission controlled by an explicit root set, curated identity authority, or stake/cost under a
  stated economic adversary model;
- caps by source, publisher/controller, shared method, and declared graph family;
- clone and input-overlap detection as a warning and, where governance chooses, a cap;
- previous-finalized-epoch meta-reputation, avoiding simultaneous circular weight computation;
- expiry, revocation, controller-change handling, and new-lineage probation;
- optional path-diversity or max-flow eligibility before PageRank-like weighting.

Levien and Aiken's attack-resistant certification metric is relevant here because it uses
source-relative maximum flow with node capacities rather than equating many incoming paths with
unlimited credibility
([USENIX paper](https://www.usenix.org/conference/7th-usenix-security-symposium/attack-resistant-trust-metrics-public-key-certification)).
Flow is a promising **eligibility or cap** mechanism; it need not replace the more interpretable
weighted blend.

Meta-vouch cycles and composition-lineage cycles are different:

- Meta-vouch cycles are expected and are handled by damping, anchoring, and caps.
- A composite depending on itself, directly or through another composite, makes epoch selection and
  provenance circular. Reject such dependencies initially. If nesting is added, require references
  to prior finalized epochs and flatten all atomic ancestry.

### 4.6 Reputation is not empirical quality

Peer endorsements estimate trust under a social policy. When outcome data exist, evaluate source
quality directly. A fraud classifier can be scored against later labels; a forecasting graph can
be scored with proper scoring rules; a contribution graph can be tested against retrospective
evaluations. Strictly proper scoring rules incentivize a forecaster to report its true predictive
distribution in expectation; evaluation should consider the chosen score's calibration and
resolution/sharpness behavior rather than calibration alone
([Gneiting and Raftery](https://sites.stat.washington.edu/people/raftery/Research/PDF/Gneiting2007jasa.pdf)).

Empirical performance, governance integrity, data availability, scope relevance, and social
endorsement are different dimensions. Do not collapse them into an unexplained scalar before the
policy chooses how each matters.

## 5. Other composition models worth retaining

### 5.1 Imported scores as a PageRank prior

Topic-Sensitive PageRank is direct precedent for precomputing biased PageRank vectors and combining
them for a particular context
([Haveliwala](https://www.cs.cmu.edu/~christos/courses/826-resources/PAPERS+BOOK/Haveliwala_www2003.pdf)).
TrustGraph's [graph-seeding report](GRAPH_SEEDING.md) develops the analogous idea in this codebase:
mix source distributions into the destination's teleport vector.

The standard personalized-PageRank linearity result should not be applied mechanically to the
current TrustGraph algorithm. Today, seed attesters receive a multiplier outside the outgoing-edge
normalization and a BFS-derived `trust_decay` modifies propagation
([pagerank.rs](../packages/pagerank-core/src/pagerank.rs)). Those additions make the recurrence
different from a stochastic PageRank transition. The graph-seeding report therefore proposes
removing them as part of a continuous-prior design. Final-distribution blending is unaffected by
this issue because it combines already-finalized source outputs.

Use this when source standing should propagate through a new graph's edges. Do not use it as the
implementation of a plain “33% of final score” control: the topology and destination scoring
parameters make effective source influence harder to bound and explain.

### 5.2 Edge union and multiplex networks

Concatenating raw edge logs loses source identity and applies TrustGraph's last-write-wins rule to
cross-source duplicates. If source layers matter, preserve them explicitly as a multiplex network.
Kivelä et al. provide the general multilayer terminology and framework
([Multilayer Networks](https://arxiv.org/abs/1309.7233)); De Domenico et al. show directly that a
weighted monoplex aggregation can materially change centrality rankings
([Centrality in Interconnected Multilayer Networks](https://arxiv.org/abs/1311.2906)). Multiplex PageRank variants produce
meaningfully different rankings depending on whether layer influence is additive, multiplicative,
or combined ([Halu et al.](https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0078293)).

MultiRank jointly estimates node centrality and layer influence
([Rahmede et al.](https://arxiv.org/abs/1703.05833)), but “a layer containing central nodes” is not
the same claim as “a source is accurate or well governed.” Layer centrality should not be relabeled
as epistemic reliability.

Multiplex composition is justified only when new cross-layer paths are the desired product. It is
more expensive, harder to attribute, and likely needs explicit source-level conflict rules,
per-layer normalization, and source caps.

### 5.3 Robust, agreement, and veto operators

A linear pool implements “any admitted source can contribute.” Some security and eligibility
decisions need different logic:

- a quorum or intersection rule requires support from multiple source families;
- a minimum/veto rule blocks an account when a designated risk source objects;
- a weighted median or trimmed mean limits numerical outliers;
- capped-contamination rules assume some bounded fraction of sources may be malicious;
- a geometric/log pool rewards agreement and penalizes a near-zero assessment more strongly.

These are not harmless source transforms. They change missingness semantics, clone sensitivity,
failure tolerance, and whether minority knowledge can survive. They also require comparable
cardinal or ordinal scores, which current allocation vectors may not supply. Treat each as a named,
versioned composition program and evaluate it against a concrete decision loss; do not hide it
behind the weighted-blend UI.

### 5.4 Subjective opinions and evidence fusion

If TrustGraph later represents explicit belief, disbelief, and uncertainty rather than a relative
point allocation, subjective logic offers distinct operators for trust discounting and evidence
fusion ([Jøsang, Marsh, and Pope](https://www.mn.uio.no/ifi/english/people/aca/josang/publications/jpm2006-itrust.pdf)).
Its most important lesson for this project is not a formula but a precondition: combining
independent observations is different from combining dependent or copied observations.

Current TrustGraph outputs do not carry calibrated uncertainty, evidence counts, or correlation
lineage. Applying a Bayesian or subjective-logic label to them would create false precision. That
work should wait for a richer output type.

## 6. Proven composition architecture

### 6.1 What can be reused

The existing proof pipeline already provides valuable building blocks:

- a checkpoint freezes input commitments and parameters before proving;
- a journal binds inputs, params, output root, canonical-blob digest/CID, total value, recipient,
  and instance domain ([MerkleSnapshot.sol](../src/contracts/merkle/MerkleSnapshot.sol));
- the standard output leaf remains `(address, value)`, so governance and distribution consumers can
  reuse membership proofs;
- the canonical blob and Merkle utilities can be reused;
- `TrustAccumulatorMirror` demonstrates checkpointing an upstream instance's live input without a
  race ([TrustAccumulatorMirror.sol](../src/contracts/merkle/TrustAccumulatorMirror.sol));
- the contributions program demonstrates a two-input derived computation, although it recomputes
  upstream PageRank from raw trust edges rather than consuming a posted score root
  ([CONTRIBUTION_FUNDING.md](CONTRIBUTION_FUNDING.md)).

The current program's frozen PageRank parameters and verifier should not be stretched to encode an
arbitrary source list. Create a `trust-compose` program with its own core, guest/vkey, parameter
codec, validator, factory/controller, operator handler, indexer type, and golden vectors.

### 6.2 Pin a complete source-state manifest

The most concrete same-chain design is a bounded **pull-at-trigger**
`CompositionSourceAccumulator` (name illustrative). Its live `acc()` reads each configured,
immutable source snapshot's latest accepted state and hashes a canonical manifest. Its
`checkpoint()` repeats the same calculation and stores that accumulator/count. This distinction
matters: `MerkleSnapshot.trigger()` compares live `acc()/leafCount()` before it asks the accumulator
to checkpoint, so constructing the manifest only inside `checkpoint()` would fail its no-new-input
logic. The same commitment can occupy one existing journal lane.

The manifest must include `captureBlock = block.number`. It makes the composer's cutoff/freshness
reference available to the guest and ensures the live accumulator changes as time advances even
when sources do not. Both `acc()` and `checkpoint()` run in the same transaction/block and must
derive identical commitments. This requires O(N) external source reads twice per trigger, so N
must be gas-bounded and manifest leaves should be fixed-size hashes, including a digest of the CID
string rather than dynamic text.

Including the capture block intentionally makes an otherwise unchanged source set a new input at a
later block. Configure a nonzero epoch schedule and appropriate bounty rules so permissionless
triggers cannot repeatedly commission the same effective blend merely to refresh its cutoff.

A conceptual static policy is:

```text
SourcePolicy {
  graphLineageId
  immutableSnapshotAddress
  admittedProgramAndOutputKind // governance assertion under today's source interface
  baseWeight
  adapterId
  required
  maxAgeBlocks
  familyId
}
```

The composition `paramsHash` should commit a canonical source-policy root, weight scale, output
pool, identity/scope/output-kind hashes, apportionment algorithm/version, and size bounds. The
accumulator commits only the dynamic source states captured under that static policy. Weight or
source-set rotation is therefore an explicit, timelocked parameter change rather than prover input.

The dynamic state frozen for each checkpoint should include:

```text
CompositionManifest {
  captureBlock
  sourceStates[]
}

SourceStateRef {
  immutableSourceSnapshot
  sourceStateIndex
  sourceFreezeBlock
  outputRoot
  blobSha256
  cidStringDigest
  totalValue
}
```

The current `MerkleState` exposes block, timestamp, root, blob references, and total value
([IMerkleSnapshot.sol](../src/interfaces/merkle/IMerkleSnapshot.sol)). It does **not** bind source
checkpoint ID, that checkpoint's params hash, verifier/vkey used at submission, accepted-output
block, program ID, or immutable factory provenance. The concrete snapshot has indexed state
history, but no state-to-checkpoint/config join. Registry records are mutable discovery metadata,
not a proof of source identity.

Accordingly, the initial source allowlist is part of the trust policy. It should pin immutable
snapshot addresses and admit only known deployment/code families; compatibility of source method
and configuration is a governance assertion under today's interface. A future snapshot extension
or authenticated adapter should store a mandatory source checkpoint ID, its pinned params hash,
verifier/program provenance, and accepted-output block with each state. Until then, the report must
not claim the composer cryptographically proves historical method compatibility.

Likewise, an “accepted upstream proof” is meaningful only conditional on the admitted snapshot
implementation and its verifier governance. Any arbitrary contract can mimic `getLatestState()`;
ZK does not make a malicious source contract truthful.

There is a time subtlety as well. `MerkleState.blockNumber` is the upstream
**input-freeze block**, while `MerkleState.timestamp` is written when its proof is later submitted.
That is enough to define the age of the underlying evidence and the time its result became
available, but not an exact accepted-output block. The transaction atomically captures source
state; chain reorganization safety remains an external confirmation/finality assumption. If policy
requires a delay after publication, the source state needs an `acceptedAtBlock` commitment or an
equivalent authenticated adapter.

Source entries must be canonically ordered. Reject duplicate snapshots and any source outside the
admitted base TrustGraph program set. Composite sources are excluded initially, so transitive
composition cycles cannot arise and the guest should not pretend to prove them without an ancestry
registry. A later nesting design needs a committed atomic-ancestry manifest before it can reject
duplicates and cycles.

Alternatives exist but are weaker defaults: hooks make source publication depend on each source
installing a potentially blocking composer hook; permissionless manifest submission creates a
two-transaction selection race unless a cutoff is enforced; a new composition-specific snapshot
and journal binds capture data most clearly but gives up reuse of the current journal ABI.

### 6.3 Guest computation

For a frozen composite checkpoint, the operator supplies the full source-state manifest and every
complete canonical source blob. The guest must:

1. rederive the manifest accumulator and count;
2. verify `captureBlock` and the immutable snapshot set exactly match the committed static policy;
3. verify every exact blob byte string against its SHA-256 and CID-string binding;
4. strictly decode and re-encode the canonical blob: sorted unique lowercase address keys,
   canonical positive decimal integers, no duplicate JSON fields or ignored data;
5. reconstruct every source's complete Merkle root and checked sum, matching `totalValue`;
6. enforce identity domain, capture-block freshness, required-source, and duplicate policy; treat
   admitted program/method compatibility as the explicit governance assumption described above;
7. form the union of positive source keys, treating a missing key as zero;
8. run the fully specified source-aware apportionment (or the precision method selected in Phase 0);
9. emit the normal output root, blob commitments, total value, and composition journal.

Conditional on the admitted source contract and verifier governance, the accepted upstream proof
establishes that its root and blob commitment were computed from its source checkpoint. The
composite proof establishes that those captured outputs were combined according to the committed
policy. Recursive verification of every source proof inside the composite guest appears
unnecessary for same-chain accepted states; recomputing all raw upstream graphs, as Contributions
does, duplicates work and no longer means “compose these published score roots.”

### 6.4 Freshness and liveness

Never resolve “latest” during proving. A source may advance while a proof is generated, giving the
prover discretion or creating a race. The pull-at-trigger accumulator—not the generic snapshot by
itself—must atomically commit the exact states and `captureBlock` used by the guest.

Freshness should use the source's input-freeze block, not the later proof-submission time. Define:

- maximum age at composite trigger;
- whether an additional accepted-output delay is required and, if so, how its block is committed;
- whether all required sources must share a cutoff window;
- what happens when a source has never produced an output;
- whether a composite may intentionally carry forward a still-valid source epoch.

Blocking on required sources gives the clearest semantics but couples liveness. Any fallback mode
must appear in the proven output metadata with its effective weights. Complete upstream blobs are
a proving prerequisite, not a post-compute pinning convenience: if one required blob cannot be
fetched, the composite cannot be computed even though its root exists onchain.

Cross-chain sources should be out of scope for the initial version. The same 20-byte address on two
chains is not by itself the same subject, and an EVM contract cannot trust another chain's state
without a bridge, light-client proof, or explicitly governed anchor.

### 6.5 Indexer, API, and UI implications

The indexer's offchain Merkle metadata already has an unused `sources` field, a useful conceptual
display seam, but its current `{name, metadata}[]` shape is always populated as empty and is not an
adequate provenance schema. It needs a migration. Consensus provenance must come from committed
onchain/program inputs rather than that JSON field
([offchain.schema.ts](../indexer/offchain.schema.ts)).

Every composite result should expose:

- composition program and policy version;
- exact admitted snapshot, captured state/root, and freeze block, with configuration claims clearly
  labelled as proven or governance-admitted;
- base and effective source weights;
- stale, missing, or fallback state;
- ideal per-account source contributions \(a_gp_g(x)\) and exact integer allocations;
- positive-support coverage and source disagreement;
- nesting/atomic lineage, once nesting exists.

The API and indexer currently assume one program/instance in several places, and address-key length
is used as a routing hint. Composition must be routed by registered program/output metadata, not
mistaken for an ordinary trust-graph score merely because its leaves are address-keyed.

### 6.6 Proving cost is not source count

The current operator and proving-vault model estimates work from accumulator leaf counts. A
composition manifest with three sources has three leaves, while its guest workload is driven by
the total bytes/accounts across all three blobs. Current source state does not commit either size.
Before paid proving, the program needs one of:

- an authenticated account/byte count and a new quote schema;
- policy-level maximum blob and account bounds priced pessimistically;
- or curated/unpaid proving for the initial deployment.

This is both an economic and denial-of-service constraint. Maximum source count alone is not a
sufficient circuit or bounty bound.

## 7. Threat model

| Failure mode | Why it matters | Initial mitigation |
|---|---|---|
| Raw-point scale gaming | A large `total_pool` becomes accidental influence | Normalize every source by proven `totalValue` |
| Sparse-coverage gaming | Per-account weight renormalization rewards narrow graphs | Missing is zero; keep global source weights |
| Source omission | Selected inclusion proofs can omit competitors | Require and validate complete canonical blobs |
| Stale/racy source | Prover chooses a convenient “latest” epoch | Pull exact states and capture block into the trigger commitment |
| Malicious source contract | A fake snapshot returns arbitrary “accepted” roots | Immutable allowlist, known code/deployment family, explicit governance trust |
| Compromised source | One source redirects all its mass | Source quotas/caps; bounded ideal influence; pause/removal process |
| Graph Sybils/clones | One operator manufactures apparent consensus | External admission assumption; controller/family caps; overlap warnings |
| Mutual-vouch cartel | Colluders recursively endorse one another | Sparse personalized roots, damping, flow/path caps, family limits |
| Rank laundering | A composite hides repeated or disfavored ancestry | Atomic lineage manifest; flatten nesting; reject duplicates/cycles |
| Scope laundering | Reputation earned for one task is reused for another | Scope hashes and compatible-output adapters |
| Version bait-and-switch | Endorsement of good v1 silently follows malicious v2 | Version constraints, expiry, controller history, re-endorsement rules |
| Correlated evidence | Copies look like independent agreement | Data/method/controller lineage and correlation diagnostics |
| Identity collision | Same address or DID is assumed to be one actor | Explicit identity domain and proven bindings |
| Whitewashing | A distrusted graph returns under a new ID | Publisher lineage and controller history; probation/admission policy |
| Lock-in | Early trusted graphs accumulate permanent centrality | Personalization, time decay/expiry, caps, challenger slots, audit |
| Data unavailable | Root exists but complete blob cannot be fetched | Mirrors/pinning, trigger preflight, explicit expiry/retry policy |
| Work underpricing | Three manifest leaves hide millions of source accounts | Commit/limit input size and price bytes/accounts, not source count alone |
| Precision loss | Small sources/accounts disappear through rounding | Source-aware quotas, declared errors, canonical residual rules, golden vectors |

The protocol can constrain arithmetic and provenance. It cannot prove that a community's social
judgments are fair, that two publishers are independent, or that a graph identity corresponds to a
unique human without an external assumption.

## 8. Invariants and evaluation plan

### 8.1 Consensus invariants

Golden tests across Rust, SP1, Solidity-facing journal construction, and TypeScript should cover:

- deterministic output independent of source enumeration order;
- integer weights sum exactly to the declared scale;
- source quotas and output sum exactly to the composite pool under the chosen apportionment;
- source-aware apportionment with one 100% source and \(P=T_g\) reproduces its published allocation;
- multiplying an already-published `(v, T)` pair by the same exact integer factor leaves its
  rational normalized input unchanged; independently recomputing with a new upstream pool may not;
- duplicate, self, unadmitted, and composite sources are rejected in the initial version;
- wrong bytes, canonical encoding, root, CID binding, total, source state, capture block, or
  manifest fold is rejected;
- updates after composite trigger cannot change that checkpoint;
- missing accounts contribute zero;
- empty/stale/unavailable required sources fail deterministically;
- operand order, overflow bounds, rounding, tie order, and residual ownership are canonical;
- integer source attribution sums exactly to each source quota and every account's output;
- ideal-rational error remains within the apportionment's declared bound.

### 8.2 Adversarial simulations

Before production, replay real or representative graph snapshots and simulate:

1. clone A one, ten, and one hundred times under distinct instance IDs;
2. introduce a mutually endorsing malicious graph clique with and without one trusted ingress;
3. compromise a source at each allowed weight cap;
4. make sources stale, unavailable, empty, and asynchronous;
5. vary overlap from disjoint account sets to exact clones;
6. rotate source parameters, vkeys, controllers, and output pools;
7. nest composites with repeated ancestry and extreme rounding;
8. inject one high-concentration or low-entropy source;
9. compare explicit weights with reputation-derived weights across damping and cap settings.

Track at least:

- L1 and Jensen-Shannon distribution distance;
- top-k overlap and rank correlation;
- source and positive-support coverage;
- entropy/Gini/concentration;
- per-account and global source attribution;
- pairwise source overlap and score correlation;
- leave-one-source-out sensitivity;
- effective weight by publisher family;
- percentage of reputation entering through each trusted root and path.

The ideal vector blend is algebraically simple; compatible semantics, consensus rounding, and
sensitivity of real decisions to source choice are not. Topic-Sensitive PageRank is only a narrow
precedent because it combines compatible vectors over one web transition structure, not arbitrary
cross-community reputation outputs. A weight-simplex explorer for A/B/C is therefore a high-value
research artifact before any contract work.

## 9. Product behavior

A useful composer flow would make policy visible rather than hiding it behind “AI aggregation”:

1. Select a composition type: **blend final scores** or **use scores as a prior**.
2. Select compatible graph lineages and see scope, method, operator, age, output coverage, and
   dependency warnings.
3. Allocate explicit base weights totaling 100%; equal weights are the default, not a claim of
   optimality.
4. Optionally ask graph reputation to recommend or boundedly adjust weights.
5. Preview top accounts, source attribution, disagreement, leave-one-out changes, and weight
   sensitivity.
6. Commit the policy and source/freshness constraints through the normal timelocked governance
   path.
7. On every output, show the exact frozen epochs and whether any declared fallback fired.

Terminology should stay literal:

- **Source weight** means ideal share of total influence; published integer quotas show its exact
  point-level realization.
- **Graph reputation** means scoped confidence used by a source policy.
- **Agreement** means result similarity, not independent confirmation.
- **Coverage** initially means positive-output support, not all subjects evaluated.
- **Verified** means the computation followed its committed inputs and program, not that its social
  claims are true.

## 10. Recommended roadmap

### Phase 0 — semantics and simulator

- Build an offchain reference implementation of normalized distribution blending.
- Replay at least three real or demo source outputs.
- Add the A/B/C weight-simplex explorer, attribution, disagreement, correlation, and leave-one-out
  analysis.
- Set product vocabulary and define the first compatible scope/output kind.
- Decide precision, source bounds, freshness, and failure semantics through golden examples.

**Exit criterion:** stakeholders can predict and explain results under overlap, missing accounts,
different source pools, and one compromised source.

### Phase 1 — published-manifest composition

- Publish deterministic offchain composites with signed/hashed source manifests.
- Display exact source epochs, manual weights, attribution, and limitations.
- Keep the result clearly labelled as offchain until the source-state manifest is chain-pinned and
  proven.

A signature proves who asserted a manifest; it does not prove source completeness or deterministic
epoch selection. This phase validates the product and schema, not a close substitute for Phase 2's
security.

**Exit criterion:** the API and UI model provenance correctly before contract complexity hardens
the schema.

### Phase 2 — `trust-compose` proven program

- Implement a bounded same-chain pull-at-trigger source accumulator whose `acc()` and
  `checkpoint()` commit identical immutable-snapshot states plus `captureBlock`.
- Add `composition-core`, guest/vkey, params codec/validator, factory/controller, operator support,
  indexer program typing, APIs, and frontend routes.
- Validate strict canonical source bytes and reuse the standard address/value output tree.
- Pin the initial trust boundary to admitted immutable snapshots; add a historical
  checkpoint/config adapter before claiming stronger method provenance.
- Bound and price total blob/account workload rather than source count alone.
- Add cross-language golden vectors and the adversarial suite.

**Exit criterion:** every output proves a fixed policy over atomically captured, governance-admitted
source states, with no prover discretion over membership or epoch selection.

### Phase 3 — graph lineage and endorsements

- Add stable graph lineage and authenticated authority bindings.
- Add typed, scoped, expiring, revocable vouches.
- Compute personalized graph reputation from previous finalized epochs.
- Start in advisory mode; then trial bounded automatic weight adjustment with publisher-family caps.

**Exit criterion:** graph reputation improves source discovery or robustness in simulation without
clone amplification, hidden scope changes, or unexplained effective weights.

### Phase 4 — advanced composition research

- Compare PageRank-prior composition with final blending on actual decisions.
- Prototype multiplex ranking only for use cases that need cross-layer paths.
- Evaluate max-flow eligibility/path caps and dependency-aware weight reduction.
- Introduce uncertainty/evidence fusion only with a richer, calibrated output schema.
- Consider cross-chain sources only with explicit identity and state-verification architecture.

## 11. Decisions to make before implementation

The report recommends defaults, but these choices should be made explicitly:

1. What first scope/output kind is safe to call compatible across graphs?
2. How many sources can one proven composition contain?
3. Which source programs/versions are admitted, and how is compatibility represented?
4. What fixed-point weight scale and final rounding rule become consensus?
5. What is the maximum source age, and is an additional post-publication delay needed?
6. Do required-source failures block indefinitely, expire the checkpoint, or trigger a separately
   committed fallback policy?
7. Is nesting forbidden until atomic lineage flattening exists? This report recommends yes.
8. Who owns a graph lineage, and what happens on controller, program, or params rotation?
9. Which external admission assumption anchors graph meta-reputation?
10. Is meta-reputation advisory only at launch? This report recommends yes.

## 12. Bottom line

There is a clean architecture that supports both ideas in the prompt without confusing them:

```text
verified source epochs
        │
        ├── explicit eligibility + base weights ──────────────┐
        │                                                     │
typed graph endorsements → scoped graph reputation ──optional adjustment
                                                              │
complete source score distributions → normalized convex blend
                                                              │
                                   one final point distribution + Merkle root
```

Ship the bottom path first. It directly implements “A, B, and C all count,” gives governance clear
control, preserves TrustGraph's proven output interface, and bounds each source's influence. Build
the upper path as an optional, personalized policy for finding and weighting sources. That retains
the exciting possibility of a trust graph for trust graphs without making circular social
reputation a hidden prerequisite for ordinary composition.

## Source index

Primary external references used in this report:

- Sep Kamvar, Mario Schlosser, and Hector Garcia-Molina,
  [The EigenTrust Algorithm for Reputation Management in P2P Networks](https://nlp.stanford.edu/pubs/eigentrust.pdf).
- Zoltán Gyöngyi, Hector Garcia-Molina, and Jan Pedersen,
  [Combating Web Spam with TrustRank](https://snap.stanford.edu/class/cs224w-readings/gyongyi04trustrank.pdf).
- Taher Haveliwala,
  [Topic-Sensitive PageRank](https://www.cs.cmu.edu/~christos/courses/826-resources/PAPERS+BOOK/Haveliwala_www2003.pdf).
- John Douceur,
  [The Sybil Attack](https://www.microsoft.com/en-us/research/publication/the-sybil-attack/).
- Raph Levien and Alexander Aiken,
  [Attack-Resistant Trust Metrics for Public Key Certification](https://www.usenix.org/conference/7th-usenix-security-symposium/attack-resistant-trust-metrics-public-key-certification).
- M. Kivelä et al.,
  [Multilayer Networks](https://arxiv.org/abs/1309.7233).
- Arda Halu, Raúl Mondragón, Pietro Panzarasa, and Ginestra Bianconi,
  [Multiplex PageRank](https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0078293).
- Manlio De Domenico et al.,
  [Centrality in Interconnected Multilayer Networks](https://arxiv.org/abs/1311.2906).
- Christoph Rahmede, Jacopo Iacovacci, Alex Arenas, and Ginestra Bianconi,
  [Centralities of Nodes and Influences of Layers in Large Multiplex Networks](https://arxiv.org/abs/1703.05833).
- Audun Jøsang, Stephen Marsh, and Simon Pope,
  [Exploring Different Types of Trust Propagation](https://www.mn.uio.no/ifi/english/people/aca/josang/publications/jpm2006-itrust.pdf).
- IETF,
  [OpenPGP Signature Subpackets](https://www.rfc-editor.org/rfc/rfc9580.html#section-5.2.3.20).
- Tilmann Gneiting and Adrian Raftery,
  [Strictly Proper Scoring Rules, Prediction, and Estimation](https://sites.stat.washington.edu/people/raftery/Research/PDF/Gneiting2007jasa.pdf).

Repository references most relevant to an implementation:

- [TrustGraph architecture](../docs/concepts/architecture.md)
- [Networks and programs](../docs/concepts/networks-and-programs.md)
- [PageRank computation](../packages/pagerank-core/src/pagerank.rs)
- [Point distribution](../packages/pagerank-core/src/distribute.rs)
- [Canonical output blob](../packages/zk-core/src/cid.rs)
- [Snapshot verification and checkpointing](../src/contracts/merkle/MerkleSnapshot.sol)
- [Graph seeding research](GRAPH_SEEDING.md)
- [Contribution funding research](CONTRIBUTION_FUNDING.md)
- [Multi-program platform research](MULTI_PROGRAM_PLATFORM.md)
