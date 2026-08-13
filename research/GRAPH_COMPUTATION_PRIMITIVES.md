# Graph computation primitives beyond PageRank

**Status:** research report; no implementation decision

**Date:** 2026-08-12

**Scope:** candidate graph computations that could become reusable trustgraphs primitives, with
specific attention to product semantics, adversarial behavior, deterministic SP1 execution, and
the existing checkpoint/accumulator/Merkle-root architecture.

---

## Executive conclusion

Trustgraphs should not add a shelf of algorithms that all emit an ambiguously named `trust_score`.
The useful expansion is a small set of computations with **different output contracts**:

| Question | Primitive | Output |
|---|---|---|
| Who has globally propagated standing? | Existing Trust-Aware PageRank | Global score vector |
| Why should source set S trust target T? | Path + flow/cut evidence | Paths, capacity, bottleneck cut |
| Who is close to S in context C? | Typed personalized diffusion | Contextual proximity vector |
| Is T supported, opposed, or simply unknown? | Signed opinion / harmonic propagation | Belief, disbelief, uncertainty |
| Who may enter a bounded cohort? | Group-flow admission | Accepted set / privilege level |
| Where is the graph fragile or suspicious? | Structural and anomaly analysis | Components, cuts, cores, motifs, subgraphs |

The highest-value new primitive is **provenance-aware path and flow evidence**. It is genuinely
different from PageRank, naturally explainable, and can quantify independent support and the
smallest trust bottleneck. The best near-term extension of the existing engine is **typed,
personalized diffusion**: arbitrary seed priors, edge-type and direction constraints, temporal
views, and stationary or deliberately short-horizon execution.

Before either, trustgraphs needs a canonical **graph projection** abstraction. Relation type,
scope, time, direction, provenance equivalence, and capacity policy determine what a computation
means. If they remain implicit, a correct proof can still certify a semantically meaningless or
easily gamed result.

Recommended sequence:

1. Define graph projections and typed result/witness formats.
2. Prototype path algebra plus provenance-aware max-flow/min-cut outside the guest.
3. Add cheap deterministic structural primitives: components, SCCs, bridges, articulation points,
   and k-core.
4. Generalize the diffusion substrate to weighted priors and typed/contextual graph views; add a
   short-horizon mode.
5. Explore signed/uncertainty-preserving propagation only after negative evidence has explicit
   semantics.
6. Keep community detection, fraud jobs, embeddings, and GNNs as analytic layers unless a concrete
   product decision requires a constitutional, ZK-proven output.

---

## 1. The baseline we already have

The current `trust-graph` program consumes a checkpoint-complete log of EAS attestations,
reconciles it into a directed weighted graph, and produces a normalized `{account -> score}`
vector. Its Trust-Aware PageRank has four notable semantics:

1. a two-level teleport/initial vector that reserves `trust_share` for trusted seeds;
2. an outgoing-edge multiplier for seed attesters;
3. a multi-source BFS from the seeds; and
4. an additional `trust_decay^distance` multiplier, with unreachable attesters contributing no
   propagated mass.

The implementation is integer fixed-point, uses canonical ordered collections, normalizes at the
end, and is compiled into the SP1 guest. The proof binds the result to complete checkpointed inputs,
governance-pinned parameters, one program vkey, one instance, and the output Merkle root. See the
[algorithm specification](../docs/concepts/algorithm.md),
[`pagerank.rs`](../packages/pagerank-core/src/pagerank.rs), and the
[ZK architecture](./ZK_ARCHITECTURE.md).

This baseline already occupies much of the territory associated with **TrustRank, EigenTrust, and
ordinary personalized PageRank**. Those are valuable controls and sources of design guidance, but
they are not three new product capabilities:

- TrustRank is seeded/personalized PageRank plus a seed-selection policy.
- EigenTrust turns satisfactory-minus-unsatisfactory transaction history into a normalized
  transition matrix, clips negative local scores, and runs seeded power iteration.
- Personalized PageRank replaces the current two-level seed prior with an arbitrary preference
  vector.

The existing [graph-seeding report](./GRAPH_SEEDING.md) already reaches the right conclusion for
that part of the design: generalize the prior rather than add another branded stationary solver.
It also argues that ordinary damping already supplies path-length attenuation, making the current
extra BFS decay and discrete seed multiplier candidates for removal when a continuous prior lands.

One implementation constraint matters for every proposal below. The current recurrence is written
as recipient-by-attester scans and then scans each attester's outgoing edges. Its code shape is
roughly `O(iterations * n * (n + m))`, not the sparse `O(iterations * m)` usually quoted for power
iteration. That does not invalidate the algorithm, but it means guest-cycle comparisons must use
the actual canonical implementation rather than literature asymptotics. A recorded 21/22-edge
local graph took approximately 3.7–3.8 million guest cycles in the
[scoring-rotation evidence](./SCORING_ROTATION_LOCAL.md).

---

## 2. A primitive is an output contract, not an algorithm name

A global rank, a source-relative judgment, a group membership decision, a posterior label, and an
anomaly finding should not share one interface or be casually substituted for one another.
Trustgraphs should define a small tagged result family:

```text
RankVector       { node -> normalized_score }
ProximityVector  { node -> source_relative_score, seed_contributions }
TrustEvidence    { source_set, target, value, paths, min_cut, bottlenecks }
OpinionVector    { node -> belief, disbelief, uncertainty, evidence_mass }
AcceptedSet      { node -> level, admission_witness }
Partition        { node -> component/community, boundary_metrics }
FindingSet       { finding_kind, nodes, edges, observed, baseline, severity }
```

Every result should carry:

- the checkpoint or graph-version commitments;
- a projection/policy hash;
- the exact output type and its units;
- parameter values and convergence/truncation information;
- supporting witnesses where practical; and
- sensitivity information: which edge, node, seed, or provenance group most changes the answer.

That makes it difficult for an application to silently treat “highly central,” “structurally
cohesive,” “predicted to connect,” or “not classified as Sybil” as synonymous with “trusted.”

### The graph projection is load-bearing

All solvers should operate on a canonical `GraphProjection`, conceptually:

```text
GraphProjection {
  checkpoint/lane commitments
  node and edge schemas
  included relation types
  direction and optional reverse traversal
  subject/scope rules
  validity interval or query time
  weight transform and normalization
  permitted intermediary types and hop bound
  provenance-equivalence key
  per-principal/domain/issuer capacity policy
}
```

Examples of decisions that belong here, not as undocumented solver behavior:

- whether `reviewed`, `funded`, `authored`, `vouched`, and `disputed` may compose;
- whether an expired credential is absent, decayed, or available only in a historical view;
- whether five attestations from accounts controlled by one principal count as one or five;
- whether a path may move from “trusted to review cryptography” to general delegation; and
- whether multiple edges copied from one source document are independent evidence.

For the current single-schema address graph this can begin as a small wrapper around the reconciled
graph. It becomes essential for Hypercerts, contributions, ERC-8004, cross-program composition, and
any future signed or multi-schema computation.

---

## 3. Priority 1: generalized paths and evidence-diversity flow

### 3.1 Path algebra

A common traversal engine can answer several useful questions by changing the path algebra:

| Algebra | Combine along path | Choose between paths | Meaning |
|---|---|---|---|
| Boolean | AND | OR | Reachability |
| Min-plus | Sum | Minimum | Cheapest/shortest path |
| Max-times | Product | Maximum | Strongest multiplicative path |
| Max-min | Minimum edge | Maximum | Widest/best-bottleneck path |

Useful outputs include the best path, its bottleneck, a bounded set of alternative paths, and an
explicit “no permitted path” result. BFS is `O(n+m)` for unweighted reachability. Dijkstra-style
shortest and widest path queries are about `O(m+n log n)` per source. A strongest-product query can
be reduced to shortest path using `-log(weight)`, but a proven fixed-point implementation should
use a canonical integer comparison or rational product rather than platform-dependent logarithms.

This primitive supports:

- “Is there a valid delegation or trust chain from this committee to this account?”
- “What is the strongest permitted chain, and which edge limits it?”
- “Which accounts are reachable only through an expired credential or one broker?”
- “Did all edges in this apparent chain coexist at the query time?”

The path is its own explanation and a compact proof witness. The main failure is semantic, not
computational: multiplying edge confidences does not produce a probability when evidence is
correlated, and attackers can create a short, apparently strong bridge. The projection must bound
hops, constrain relation sequences, and collapse shared provenance.

Primary references: [Dijkstra's shortest-path paper](https://doi.org/10.1007/BF01386390) and a
[modern widest-path treatment](https://arxiv.org/abs/1808.10658).

### 3.2 Max-flow/min-cut and disjoint support

Path selection finds the best route; flow asks how much **independent capacity** connects trusted
territory to a target. The dual min-cut identifies the smallest bottleneck whose removal breaks or
reduces that support. Vertex splitting lets the same machinery assign capacities to intermediary
nodes rather than only edges.

Proposed interface:

```text
trust_flow(projection, source_set, target, capacity_policy) -> {
  max_flow,
  min_cut,
  path_decomposition,
  edge_disjoint_count,
  vertex_or_domain_disjoint_count,
  bottlenecks
}
```

This is a strong complement to PageRank because it measures **support diversity and attack
bottlenecks**, not popularity or stationary visit probability. The original Levien–Aiken work
developed an explicit node/edge attack model and a practical max-flow trust metric that nearly met
its theoretical attack-resistance bound. The min-cut is also unusually legible to governance:
“all support for this account passes through these two issuers” is actionable in a way that a score
of 0.0047 is not. See the [original USENIX paper](https://www.usenix.org/conference/7th-usenix-security-symposium/attack-resistant-trust-metrics-public-key-certification).

The important trustgraphs-specific design is **capacity by real independence**, not raw edge count.
Ten vertex-disjoint address paths may still be controlled by one person, funded by one wallet,
issued from one service, or copied from one document. Capacity policies should be able to cap a
principal, issuer, provenance root, administrative domain, or infrastructure cluster. The output
should report both raw and provenance-aware support.

Per-target flow does not safely allocate a shared resource by itself: the same boundary capacity
can be reused independently to make many Sybils look acceptable. For cohort admission or reward
allocation, use a shared supersink/group-flow construction so accepted identities compete for a
bounded common capacity budget. Advogato's deployed trust metric is the relevant precedent; it is
best understood as a group-admission primitive, not another reputation scalar. See
[Levien's dissertation](https://www.levien.com/thesis/compact.pdf).

### Fit with the ZK platform

Exact path and flow algorithms are deterministic and integer-native. The challenges are witness
size and worst-case runtime, not numerical reproducibility. Recommended first scope:

- run on a bounded projection/ego graph;
- canonicalize adjacency, tie-breaking, augmenting-path choice, and path decomposition;
- cap nodes, edges, path length, and augmentations in governance-pinned parameters;
- return one target result or one bounded cohort, not all-pairs flow; and
- prototype as an analytic/native service before deciding whether a new on-demand proof journal
  or epoch-wide Merkle root is justified.

Producing all source-target pairs would be a bad fit for the current `{node -> value}` root. A
target-specific journal, or a root over predeclared queries, is more natural.

---

## 4. Priority 2: typed personalized and transient diffusion

### 4.1 Personalized PageRank as a substrate

The canonical personalized recurrence is:

```text
pi = alpha * seed_prior + (1 - alpha) * P^T * pi
```

where the seed prior can represent one user, a committee, a topic, another program's proven root,
or a mixture. Topic-sensitive PageRank precomputes basis vectors and combines them for a query.
Local-push methods can return only the sparse neighborhood carrying material probability, and
dynamic PPR has mature residual-repair techniques after edge updates.

The computation is close to today's engine, but the **product capability** is different when the
seed and graph projection become query/context inputs:

- “trusted relative to this evaluator” rather than globally important;
- “trusted for security review” rather than across all attestations;
- reverse traversal for “who influences this decision?”;
- typed paths such as `person -> reviewed -> artifact -> authored_by -> person`; and
- a sparse, local result suitable for recommendation or exploration.

Sources: [Topic-Sensitive PageRank](https://doi.org/10.1145/511446.511513),
[personalized PageRank decomposition](https://www.ra.ethz.ch/CDstore/www2003/papers/refereed/p185/html/p185-jeh.html),
[local PageRank partitioning](https://snap.stanford.edu/class/cs224w-readings/andersen06localgraph.pdf),
and [dynamic approximate PPR](https://www.kdd.org/kdd2016/papers/files/rfp1146-zhangA.pdf).

The right implementation move is not `EigenTrust`, `TrustRank`, and `PPR` as three guest programs.
It is one canonical diffusion core with explicit policies for:

- stationary versus fixed-horizon execution;
- seed/prior construction;
- edge projection and transition normalization;
- dangling-node behavior;
- direction;
- context and time; and
- returned provenance/contribution data.

The existing binary seed prior should be treated as one policy of that substrate.

### 4.2 Short-horizon diffusion / SybilRank mode

Stationary PageRank deliberately mixes. SybilRank does the opposite: it starts at known-good
seeds, runs only a small number of walk steps, then divides landing mass by degree. The transient
signal asks how well connected an identity is to trusted territory **before** the walk equilibrates.
This produces a Sybil-suspicion/review ranking rather than reputation.

It is computationally simple, approximately `O(h*m)` for a pinned horizon `h`, and likely cheaper
to prove than convergence-based rank. It is genuinely distinct from current PageRank because early
termination and degree normalization are the semantics, not approximations.

Its assumptions must be printed next to the result. It works when honest social edges are
bilateral, the honest region mixes reasonably, and the attacker has few edges into it. Seed errors,
bought accounts, social engineering, and legitimate communities poorly connected to the seeds
produce false results. The original authors present it as prioritization for human review, not a
proof of personhood. See [SybilRank](https://www.usenix.org/conference/nsdi12/technical-sessions/presentation/cao)
and the broader [analysis of social-network Sybil defenses](https://research.google/pubs/an-analysis-of-social-network-based-sybil-defenses/).

### 4.3 Heat-kernel diffusion

Heat-kernel PageRank mixes walk lengths with a Poisson distribution and exposes a scale parameter
`t`. At short scales it finds a seed's close neighborhood; at larger scales it reveals broader
structure. A conductance sweep over the heat vector can return a local community boundary.

This is useful for “nearby at scale t,” seed-centered community discovery, and boundary analysis.
It is more distinct from PageRank than another teleport policy, but dynamic maintenance is less
mature. In a guest, the matrix exponential must become a pinned fixed-point polynomial/truncated
series with an explicit error contract. Treat it as a second-wave experiment after local PPR.

Sources: [The Heat Kernel as the PageRank of a Graph](https://pmc.ncbi.nlm.nih.gov/articles/PMC2148367/)
and [heat-kernel local clustering](https://arxiv.org/abs/1503.03155).

### 4.4 HITS/SALSA when roles are genuinely bipartite

HITS emits two scores: hubs point to good authorities, and authorities are pointed to by good hubs.
That can distinguish creators/experts from curators/discoverers in a typed graph. SALSA expresses
similar roles as alternating walks and avoids some of HITS's winner-take-all spectral behavior.

This is valuable only where the schema gives the roles clear meaning—for example reviewer versus
artifact, curator versus source, or claimant versus validator. On an undifferentiated vouch graph,
dense collusive bipartite blocks can manufacture both roles and the extra scores add little.

Sources: [Kleinberg's HITS paper](https://www.cs.cornell.edu/home/kleinber/auth.pdf) and
[SALSA](https://doi.org/10.1145/382979.383041).

---

## 5. Priority 3: deterministic structural audit primitives

These computations are cheap, exact, and useful even if they never directly control voting or
rewards.

| Primitive | Output and use | Static cost | Warning |
|---|---|---:|---|
| Weak/strong components | Trust islands; mutually reachable domains; condensation DAG | `O(n+m)` | Connectivity is not endorsement |
| Bridges/articulation points | Single edges/accounts whose removal disconnects support | `O(n+m)` | Add provenance-aware principal removal |
| Biconnected components | Regions resilient to one edge/vertex failure | `O(n+m)` | Multiple accounts may share control |
| k-core/degeneracy | Embeddedness and cohesive shells | `O(m)` | A Sybil ring can manufacture a high core |
| Degree/reciprocity | Basic local activity and mutual-vouch rate | `O(1)` update | Trivially farmable |
| Sampled betweenness | Brokers and capture/choke-point risk | Expensive exact; sample sources | High brokerage is risk, not trust |

The [Batagelj–Zaveršnik k-core algorithm](https://arxiv.org/abs/cs/0310049) is linear and has
incremental descendants. Exact betweenness is much more expensive; use sampled sources if needed,
following [Brandes](https://doi.org/10.1080/0022250X.2001.9990249).

Recommended output is a `StructuralSnapshot` Merkle map plus small component/cut witness blobs.
These features can support UI, governance risk dashboards, query planning, and anomaly baselines.
They should not be blended into reputation without an explicit application model.

---

## 6. Priority 4: competing labels, distrust, and uncertainty

### 6.1 Harmonic label propagation

Fix labeled seed nodes and assign every unlabeled node the weighted average of its neighbors. The
result minimizes graph energy and can be read as the probability that a random walk first hits each
labeled boundary. With several labels it can answer:

- trustworthy / untrustworthy / unknown;
- supports / disputes / no evidence;
- topic or policy classifications; and
- risk categories with an abstention threshold.

This is not centrality: labels compete and the output is a distribution or uncertainty value.
Iterative averaging is about `O(iterations * m * classes)`; deterministic Laplacian solvers are
possible but need a canonical fixed-point and stopping specification.

Poisoned seeds and strategic bridges are the main attacks. Seed diversity, capped influence, soft
labels with evidence mass, and an explicit high-entropy “unknown” outcome are necessary. See
[Gaussian Fields and Harmonic Functions](https://www.cs.cmu.edu/~zhuxj/pub/zgl.pdf).

### 6.2 Signed trust and Subjective Logic

Unknown, neutral, and distrusted are different states. Do not represent all three as zero, and do
not insert negative weights into a stochastic transition matrix as if they were probabilities.
Guha et al. keep trust and distrust in distinct channels and study direct propagation,
co-citation, transpose, and combinations on a large signed network. See
[Propagation of Trust and Distrust](https://research.google/pubs/propagation-of-trust-and-distrust/).

Subjective Logic offers an appealing output contract:

```text
opinion(source, target, scope) -> {
  belief,
  disbelief,
  uncertainty,
  base_rate,
  effective_evidence_mass,
  evidence_paths
}
```

Referral trust discounts downstream functional opinions; fusion combines evidence. The hard part
is dependence: overlapping paths and copied evidence get double-counted, and the algebra's
operators cannot be reordered freely. Any implementation must retain path/provenance information
and define correlation caps. It should also distinguish “I distrust X's ability to perform this
task” from “I distrust X as a recommender.” See Jøsang's
[Subjective Logic](https://link.springer.com/book/10.1007/978-3-319-42337-1) and
[semantic constraints for trust transitivity](https://sites.cc.gatech.edu/home/isbell/classes/reading/papers/josang/JP2005-APCCM.pdf).

This is a medium-term primitive. Shipping negative attestations before their scope, appeal,
revocation, retaliation, and privacy semantics are designed would create a governance problem that
the graph math cannot solve.

---

## 7. Temporal computation is a graph view, not one algorithm

Every solver should support an “as of” graph. Static aggregation can invent a trust chain whose
edges never coexisted. Useful policies include:

- validity intervals and exact historical snapshots;
- sliding windows;
- piecewise or exponential weight decay;
- separate recent and lifetime channels;
- earliest-arrival and fastest time-respecting paths; and
- changes in degree, motifs, core, cut size, or component membership between epochs.

A decay policy can be materialized in `O(m)` and reused by paths, flow, diffusion, and labels. The
fixed-point guest should prefer a governance-pinned rational/piecewise schedule or lookup table to
a floating exponential.

Decay is not automatically Sybil resistance. Fast forgetting can reward whitewashing, on/off
behavior, and a stream of fresh Sybil identities. MeritRank's experiments found cases where epoch
decay worsened Sybil tolerance. Always return effective evidence mass or uncertainty with a decayed
score, so one fresh observation does not look equivalent to long-established evidence. Sources:
[temporal-network foundations](https://doi.org/10.1016/j.physrep.2012.03.001) and
[MeritRank](https://arxiv.org/abs/2207.09950).

---

## 8. Analytic primitives: motifs, fraud rings, and communities

### Motifs and local similarity

Common neighbors, Jaccard, Adamic–Adar, reciprocity, triangles, directed short cycles, feed-forward
loops, and bipartite butterflies are useful for:

- suggested attestations or relationships;
- circular-vouch and mutual-endorsement review;
- coordinated reviewer–target blocks;
- entity-resolution candidates; and
- local features for later anomaly models.

These are explainable because the supporting neighbors or motif instances can be returned.
Triangle changes reduce to a neighbor-set intersection; larger motifs require bounded enumeration
or streaming estimates. Sources: [link prediction](https://doi.org/10.1002/asi.20591),
[network motifs](https://doi.org/10.1126/science.298.5594.824), and
[TRIÈST dynamic triangle estimation](https://research.google/pubs/tri%C3%A8st-counting-local-and-global-triangles-in-fully-dynamic-streams-with-fixed-memory-size/).

The warning is straightforward: legitimate teams are reciprocal and dense too. A motif is a
reviewable pattern, not proof of collusion.

### Fraud/anomaly jobs

Good initial offline jobs are:

- greedy densest-subgraph peeling;
- OddBall-style deviations in ego-network edge count, weight, and eigenvalue relationships; and
- FRAUDAR-style dense bipartite block detection with camouflage resistance.

They should emit a suspicious subgraph, the observed features, the comparison baseline, and a
severity—not silently subtract from trust scores. Low-and-slow fraud remains difficult, and normal
high-volume actors can be false positives. Sources: [OddBall](https://www.cs.cmu.edu/~mmcgloho/pubs/pakdd10.pdf)
and [FRAUDAR](https://www.kdd.org/kdd2016/papers/files/rfp0110-hooiA.pdf).

### Community detection

Leiden/CPM and Infomap can support visualization, group-level analysis, local baselines, and
indexing/sharding. Leiden fixes Louvain's ability to emit disconnected communities; Infomap is a
natural fit for directed weighted flow. These are useful heuristic partitions, not trust truth.
Results can move with resolution, tie-breaking, and small graph changes; modularity also has a
small-community resolution limit.

If deterministic replay becomes necessary, pin initialization, node order, tie-breaking, objective,
resolution, pass count, and integer arithmetic. Even then, use the partition as an analytic result.
Sources: [Leiden](https://doi.org/10.1038/s41598-019-41695-z),
[Infomap](https://doi.org/10.1073/pnas.0706851105), and the
[modularity resolution limit](https://doi.org/10.1073/pnas.0605965104).

---

## 9. Learned graph methods: downstream only for now

node2vec, GraphSAGE, GCNs, and temporal GNNs can help with candidate generation, similarity,
classification, and fraud detection once trustgraphs has features and labeled outcomes. They should
not be first-class trust primitives yet:

- the training set and objective introduce a larger trust boundary than the graph computation;
- outputs are difficult to explain to governance participants;
- training and inference are nondeterministic unless heavily constrained;
- models drift and require retraining/monitoring;
- neighborhood homophily can encode social bias; and
- graph structure and features can be adversarially perturbed.

Use learned outputs to prioritize review or generate candidates, alongside deterministic witnesses.
Do not place them directly in governance/reward paths until there is a task-specific dataset,
calibration story, adversarial evaluation, reproducible model commitment, and a clear reason a
deterministic primitive is insufficient.

Sources: [node2vec](https://pmc.ncbi.nlm.nih.gov/articles/PMC5108654/),
[GCN](https://arxiv.org/abs/1609.02907),
[GraphSAGE](https://papers.nips.cc/paper_files/paper/2017/hash/5dd9db5e033da9c6fb5ba83c7a7ebea9-Abstract.html),
and the [Nettack adversarial study](https://arxiv.org/abs/1805.07984).

---

## 10. Comparative recommendation matrix

Ratings are relative to the current trustgraphs architecture. “Proof fit” includes deterministic
arithmetic, bounded execution, and whether the output maps naturally to the current epoch/Merkle
model.

| Family | New product capability | Proof fit | Adversarial clarity | Recommendation |
|---|---|---:|---:|---|
| Generalized prior / PPR | Contextual proximity | High | Medium | **Build as diffusion substrate** |
| Path algebra | Explicit trust/delegation chains | High | High | **Prototype first** |
| Provenance-aware flow/cut | Independent support and bottlenecks | Medium | High | **Prototype first** |
| Group/Advogato flow | Bounded cohort or privilege admission | Medium | High | **Prototype after pair flow** |
| Components/bridges/k-core | Structural audit and fragility | High | High | **Build cheap bundle** |
| Temporal projection/paths | As-of and causally valid trust | High | Medium | **Make cross-cutting** |
| Short-horizon/SybilRank | Suspicion/review ordering | High | Assumption-sensitive | **Experiment, never identity proof** |
| Harmonic labels | Competing categories + uncertainty | Medium | Medium | **Second wave** |
| Signed opinion/Subjective Logic | Trust/distrust/unknown | Medium | Medium | **Research after edge semantics** |
| Heat-kernel diffusion | Multi-scale locality/boundaries | Medium | Medium | **Compare with local PPR** |
| HITS/SALSA | Curator versus authority roles | High | Low–medium | **Only on typed bipartite schemas** |
| Motifs/local similarity | Explainable candidates/findings | High | Medium | **Analytic API** |
| Fraud-ring jobs | Suspicious subgraphs | Medium | Medium | **Offline analytic jobs** |
| Leiden/Infomap | Heuristic partitions | Low–medium | Low | **Visualization/analysis only** |
| EigenTrust/TrustRank | Another seeded global vector | High | Known | **Baselines, not new programs** |
| Embeddings/GNNs | Learned prediction/similarity | Low | Low | **Experimental downstream layer** |

---

## 11. Suggested architecture

### Three execution classes

Do not force every useful computation into the same publication path.

1. **Epoch root producers**

   Global outputs whose consumers need constitutional correctness: rank vectors, structural maps,
   accepted sets, or perhaps label distributions. These fit a new core crate + guest bin + vkey +
   golden vectors + snapshot root.

2. **On-demand proven queries**

   Source-target paths, flow/cut evidence, or a bounded local neighborhood. These want a compact
   query-bound journal, not an epoch-wide all-pairs Merkle map. The journal should bind the graph
   checkpoint, projection hash, query, result, and witness commitment.

3. **Reproducible analytics**

   Community partitions, anomaly jobs, learned candidates, and exploratory centralities. Publish
   graph checkpoint, code/version, parameters, and result blob; do not incur a vkey rotation or
   imply governance-grade semantics until a consumer actually needs them.

### Shared core boundaries

```text
checkpointed inputs
        |
        v
canonical reconciliation
        |
        v
GraphProjection  -- edge/time/scope/provenance policy
        |
        +--> traversal-core   -- paths, reachability, temporal traversal
        +--> flow-core        -- flow, cut, admission
        +--> diffusion-core   -- stationary/transient propagation
        +--> structure-core   -- components, core, motifs
        +--> opinion-core     -- harmonic/signed inference (later)
        |
        v
typed result + witnesses + canonical blob/Merkle commitment
```

`zk-core` should continue to own program-agnostic encoding, fixed-point, fold, Merkle, CID, and
journal primitives. New algorithm crates should not depend on `pagerank-core` simply to reuse graph
types; extract a small deterministic graph/projection representation when the first prototype
shows the correct boundary.

### Determinism checklist for promotion into SP1

- no floating point, hash-map iteration, unseeded randomness, wall-clock time, or platform math;
- canonical node/edge ordering and duplicate reconciliation;
- explicit overflow policy and fixed-point rounding order;
- pinned tie-breaking for equal paths, cuts, labels, and communities;
- hard resource bounds in parameters, validated before proving;
- convergence and truncation flags committed in the result;
- native/guest byte equality plus Solidity/TypeScript parity where those languages consume the
  encoding; and
- attack fixtures and metamorphic tests in addition to happy-path golden vectors.

---

## 12. Prototype and evaluation plan

### Phase A — projection and witness spike

Define the smallest useful `GraphProjection` over the existing reconciled vouch graph:

- relation/direction filter;
- query-time validity filter;
- maximum hops;
- edge weight transform;
- provenance/principal grouping key; and
- edge/node/group capacity caps.

Implement native deterministic reachability, shortest, widest, and strongest-product queries.
Return canonical path witnesses and projection metadata. This phase should not change a guest,
contract, or score.

### Phase B — flow and structural spike

Add vertex-split max-flow/min-cut on bounded subgraphs plus WCC/SCC, bridges, articulation points,
and k-core. Compare raw address-disjoint flow with provenance-aware flow. Test whether the cut/path
explanations are useful in the frontend or governance review.

### Phase C — diffusion comparison

Refactor a native experimental sparse diffusion implementation around a weighted prior and graph
projection. Compare:

- current Trust-Aware PageRank;
- generalized-prior PPR;
- local-push PPR;
- fixed-horizon degree-normalized diffusion; and
- optionally heat diffusion at two or three fixed scales.

Do not change the canonical guest until the experiment resolves whether the current seed
multiplier/BFS decay should be retained. The graph-seeding report already provides a strong case
for replacing those mechanisms with a continuous prior plus ordinary damping.

### Phase D — promotion decision

For each candidate, name the consumer before choosing the proof/publication model:

| Candidate | Likely first consumer | Publication candidate |
|---|---|---|
| Path + cut evidence | Profile/governance inspector | Reproducible analytic, then on-demand proof |
| Group flow | Committee/admission module | Epoch accepted-set root |
| Typed PPR | Recommendations/contextual ranking | Query cache or per-context root |
| Structural bundle | Risk dashboard/indexer | Reproducible blob; prove only if gating rights |
| SybilRank mode | Review queue | Analytic finding set |
| Harmonic labels | Claim/risk classification | Per-label root if policy-gating |

### Required benchmark graphs

Use both real checkpoints and small synthetic families with known expected behavior:

- disconnected reciprocal Sybil ring;
- one compromised bridge into a large Sybil fan-out;
- serial Sybil chain;
- dense bipartite review fraud block with camouflage edges;
- honest graph with several weakly connected communities;
- one compromised seed;
- one high-degree confused honest attester;
- duplicated evidence from one provenance root;
- temporally impossible path whose edges never coexisted;
- context laundering across incompatible relation types;
- whitewashing and on/off temporal behavior; and
- legitimate dense team/community as a false-positive control.

Measure:

- attacker share or admitted identities per attack edge/principal;
- sensitivity to one seed, bridge, or edge removal;
- false positives across honest communities;
- stability between adjacent checkpoints;
- explanation/witness size;
- native time and memory;
- SP1 executor cycles as a function of `n`, `m`, horizon, classes, or augmentations;
- fixed-point error and convergence/truncation behavior; and
- output-root determinism across native and guest execution.

No graph algorithm creates identity uniqueness. Every Sybil claim in the evaluation must state the
scarcity assumption—trusted seeds, scarce attack edges, capacity by principal, stake, verified
credentials, or some combination. Douceur's foundational result remains the right warning:
[The Sybil Attack](https://www.microsoft.com/en-us/research/publication/the-sybil-attack/).

---

## 13. Decision summary

### Do next

- Specify `GraphProjection` and typed result/witness envelopes.
- Build native path-algebra and provenance-aware flow/cut spikes.
- Add the linear-time structural audit bundle.
- Treat arbitrary weighted priors and typed graph views as the evolution path for the current
  PageRank core.
- Benchmark actual guest cycles early; do not infer proof feasibility from conventional graph
  asymptotics.

### Explore after those foundations

- group-flow admission;
- short-horizon Sybil review ranking;
- multi-label harmonic propagation;
- temporal paths and structural deltas;
- heat-kernel locality; and
- typed HITS/SALSA on schemas with real hub/authority roles.

### Do not prioritize as first-class primitives

- standalone TrustRank or EigenTrust guest programs;
- raw centrality as reputation;
- community membership as evidence of trust or fraud;
- negative weights inside the existing Markov chain;
- unqualified time decay as an anti-Sybil mechanism; or
- embeddings/GNN outputs in governance or reward paths.

The strategic opportunity is to make trustgraphs answer more kinds of graph questions while
preserving its strongest property: every important answer names its inputs and semantics precisely
enough to reproduce, explain, and—where necessary—prove.
