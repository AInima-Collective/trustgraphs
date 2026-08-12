# Graph Seeding: Initializing trustgraphs with Scores, Without Attestations

**Status:** research report, 2026-07-22. Design-thinking output; no implementation decision yet.
**Question:** how do we initialize a trust graph with a pre-existing score distribution (cold-start bootstrap, imported standing) instead of, or ahead of, organic attestations?

---

## 1. TL;DR

Seeding is not a new mechanism. The teleport vector in our Trust-Aware PageRank is already a
personalized prior; today it is just restricted to a two-level step function (seeds split
`trust_share`, everyone else splits the remainder, `pagerank.rs:36-70`). The canonical literature
(TrustRank's static distribution vector `d`: "arbitrary, non-negative entries summing to one") says
the general form is a continuous weighted prior, and the Jeh-Widom linearity theorem says scores are
*linear* in that prior: no interaction effects, no new convergence argument, and any node's score
decomposes into per-seed contributions for auditing.

Concretely, the proposal that falls out of this research:

1. Generalize `trusted_seeds: Vec<Address>` into a weighted prior `{node → weight}`, entering the
   algorithm exactly where `initialize_scores` sits today.
2. **Delete `trust_decay` and `trust_multiplier`.** Both key off discrete seed membership and hop
   distance, which are ill-defined under a continuous prior, and the literature confirms distance
   decay is already an emergent property of the damping factor. Net deletion of mechanism.
3. Commit the prior as a `seed_prior_root` **inside the params-hash preimage** (extending today's
   `seedSetRoot` leaf to `(node, weight)`), full vector supplied to the guest as a witness blob that
   re-derives the root. This keeps the frozen 10-field journal envelope untouched and keeps prior
   rotation on the operational timelock, per ZK_ARCHITECTURE's two-tier authority.
4. Structure the prior as a **mixture**: `d = λ_u·Uniform + λ_p·P_persistent + λ_b·P_bootstrap`,
   where the uniform floor is mandatory (ergodicity), persistent components carry imported standing
   per-source, and the bootstrap component fades as trusted attestation mass accumulates
   (Bayesian pseudo-count schedule, computed from the *previous* epoch's committed root).
5. Key prior entries by node id, not address: `did_node_id` already exists and the hypercerts
   program's seeds are already DID-keyed, so non-address identities (Bluesky DIDs, hypercert
   contributors) claimable via proven `link.evm` bindings are shipped machinery, not new design.

The mechanism is the easy part. The two hard parts are **provenance** (the prior relocates the root
of trust into the source data; every production cautionary tale is about the imported signal, not
the algorithm) and **normalization** (heavy-tailed imports must be compressed, and every concave
transform subsidizes identity-splitting).

## 2. Why seed

- **Cold-start bootstrap.** PageRank on a near-empty graph is degenerate. EigenTrust makes this
  precise: a node with no outgoing trust falls back to the pretrust vector, so the fixed point of a
  nearly-empty graph is approximately the prior echoed back. That is expected behavior; day-one
  scores *are* the prior, and organic structure takes over as edges arrive.
- **Imported standing.** A community already has reputation elsewhere (hypercert impact scores, a
  prior trustgraphs instance, contribution history) and wants it as a durable prior rather than
  starting from zero.

These pull temporality in opposite directions (fade vs persist), which is why the prior must be a
mixture of components with independent lifecycles rather than one vector.

## 3. Theory: the mechanism is safe and already half-built

- **Continuous priors are the canonical general form.** TrustRank (Gyöngyi et al., VLDB 2004) defines
  `d` as arbitrary non-negative entries; binary seed sets were an artifact of their human-oracle
  budget. Topic-Sensitive PageRank (Haveliwala) is the direct ancestor of "import a prior as
  teleport mass."
- **Linearity (Jeh-Widom, WWW 2003).** PPR of a convex combination of preference vectors is the same
  combination of the individual PPVs. Weighted seeding is well-conditioned (sensitivity ~ α/(1−α),
  fine at α = 0.85), and gives a transparency dividend: any score decomposes into
  prior-contribution vs organic-contribution, answering "is X only ranked because of the import?"
- **Damping already is distance decay.** TrustRank §4.3 states biased PageRank implements trust
  dampening per hop via α; Baeza-Yates et al. (2006) prove PageRank corresponds exactly to
  exponential decay α^t on path length. Our separate `trust_decay` BFS mechanism is a second copy of
  something the damping factor provides. (If we ever want slower-than-exponential attenuation, the
  damping-functions paper is the principled route.)
- **Keep the teleport floor forever.** EigenTrust requires the pretrust blend weight > 0 for
  irreducibility/convergence. Fading targets the *uniform* vector, never zero teleport.
- **Seed out-reach matters.** TrustRank's seed-selection result (inverse PageRank): a prior's
  usefulness depends on the out-reach of the nodes it lands on. Prior mass on accounts that never
  attest ranks them but propagates nothing. Expect and communicate this.
- **Honest caveat.** No paper directly compares binary-uniform vs continuous-weighted seeds
  all-else-equal. Theory says continuous is safe; Topical TrustRank is indirect evidence that weight
  distribution across seeds measurably matters; the value will come from the quality of the imported
  signal, not the mechanism.

## 4. Code audit: the seam is small and localized

Full dependency audit summary (cites verified against the repo):

- The binary seed set drives four behaviors, all in `packages/pagerank-core/src/pagerank.rs`:
  initial-score split (`:36-70`), BFS distances from seeds (`:74-96`), the `trust_multiplier` boost
  on seed-attester edges (`:168-172`), and `trust_decay^distance` attenuation, including a silent
  null-out of attesters unreachable from any seed (`:174-184`, `:177`). The first two generalize
  naturally to weights; the last two only make sense for discrete membership and are the deletion
  candidates. Removing decay is a behavioral change beyond scalars: the unreachable-attester
  null-out disappears, changing *who* contributes, not just how much.
- `compute.rs`, `distribute.rs`, `reconcile.rs`, `lane2.rs` never touch seeds/decay/multiplier. The
  whole dependency is `pagerank.rs` + `encode.rs`/`merkle.rs` (commitment) + `lib.rs` (types),
  mirrored 1:1 in `frontend/lib/pagerank/*` and `src/contracts/params/ParamsCodec.sol`.
- **Commitment placement is already answered by our own constraints.** ZK_ARCHITECTURE's two-tier
  authority: vkey = constitutional, `paramsHash` (including `seedSetRoot`) = operational; "seed
  rotation must not be gated behind a circuit-upgrade ceremony." MULTI_PROGRAM_PLATFORM freezes the
  10-field journal envelope, with per-program variation living entirely in `paramsHash` + vkey. Both
  point the same way: `seed_prior_root` goes in the params-hash preimage (slot alongside/replacing
  `seedSetRoot`, `encode.rs:79-112`), not the journal.
- **The witness pattern exists.** Guest receives the full `{node → weight}` list privately and
  re-derives the committed root, exactly as lane-2 re-folds the anchor log (`lane2.rs:40-47`) and
  hypercerts re-folds its blob (`hypercerts-core/src/compute.rs:181-189`). Extending the seed leaf
  from `keccak256(abi.encode(address))` to `keccak256(abi.encode(node, weight))` mirrors
  `output_leaf` in `merkle.rs`.
- **DID keying is precedent.** The rank core is key-generic; hypercerts already instantiates seeds as
  `trusted_seed_dids` hashed through `did_node_id` (`semantics.rs:71-73`), with `link.evm` EIP-712
  bindings attaching EVM addresses. A prior keyed by DIDs, claimable by proven bindings, reuses M1/M3
  machinery. Unclaimed identities can sit in the topology as nodes (the hypercerts artifact-node
  pattern); their mass flows once bindings land.
- **Ergodicity requirement.** Teleport mass is proportional to initial score (`pagerank.rs:134`); a
  zero-weight node gets zero teleport and, with no inbound edges, silently vanishes from the output
  (`compute.rs:33-34` filters zeros). The mixture must guarantee a strictly positive uniform floor,
  and the fixed-point arithmetic must avoid truncation-to-zero for tiny weights.
- **Costs.** Any guest change rotates the vkey (ELF layout changes even under refactors), and the
  shared `RankConfig` means the hypercerts and signer programs rotate too: batch this into one
  scheduled constitutional rotation. Every golden family regenerates (three JSON fixtures, three
  Solidity golden tests, frontend `golden.test.ts`); behavioral decay/multiplier coverage is thin
  (essentially one Rust test), so most churn is encoding parity.

## 5. Temporality: the mixture and the fade

```
d = λ_u·Uniform + Σ_s λ_s·P_source_s + λ_b·P_bootstrap        (Σλ = 1, λ_u > 0 always)
```

- **Per-source components** make trust judgments explicit: each source is a separately committed
  root with its own λ, auditable and droppable independently. "We reduced Gitcoin's weight" is a
  legible params rotation, not a re-derivation of an opaque merged vector.
- **The fade has exact prior art: Bayesian shrinkage.** IMDb's classic weighted rating
  `WR = v/(v+m)·R + m/(v+m)·C` is this design in miniature: prior strength `m` expressed in units of
  evidence, fading automatically as evidence accumulates. Our one interpretable knob:
  `λ_b = m/(m + S)` where S is accumulated attestation mass. "The bootstrap prior is worth m
  attestations" is a parameter a governance forum can actually argue about.
- **Gate the fade on trusted mass, not raw counts.** There is no direct literature on
  density-dependent fade schedules (genuinely open), but the known attack on Bayesian averages
  transfers: raw evidence volume is manufacturable (spam attestations to wash the prior out early,
  or suppress activity to keep it alive). Fix: S = attestation mass weighted by the *previous
  epoch's committed scores*. This is Sybil-resistant for the same reason the rank is, keeps λ_b out
  of the fixed-point iteration (convergence proof untouched), and makes the schedule publicly
  recomputable from the prior root.
- **Persistent components re-derive per epoch from their upstream source** rather than freezing at
  genesis: standing that decays upstream (a hypercert re-evaluated downward) decays here too,
  avoiding lock-in. We deliberately did not pursue "each epoch's output becomes the next prior"
  (recursive momentum): it is the rich-get-richer lock-in path and makes early errors permanent.

## 6. Provenance and normalization: where the risk actually lives

Seeding moves the root of trust from the computation (proven) into the input (attested). Every
production cautionary tale is about the input:

- **Gitcoin Passport**: static, public, additive stamp weights over farmable credentials became a
  price list (~44 points cheaply manufacturable vs a 20-point threshold); after ~3 years of
  rebalancing they abandoned user-facing weights for behavioral models. Lesson: a published weight
  vector over cheaply-manufacturable sources is an attack surface with a posted bounty.
- **SourceCred**: metrics computed from performable behavior (props channels, reactions) Goodharted
  fastest; artifact-anchored metrics (merged code) held up. Lesson: prefer priors from expensive,
  independently evaluated artifacts. Hypercert impact scores sit at the good end *if* evaluation is
  independent of the people scored.
- **OpenRank/Karma3** (closest production comparable, runs EigenTrust for Farcaster): pretrust is
  ~100 hand-curated VIP profiles from a Dune dashboard, and verifiability is TEE + EigenLayer
  slashing, not ZK. Two takeaways: our SP1 story is a real differentiator, and it only survives
  seeding if the prior's derivation is committed alongside the root (source root + transform named
  in params, blob published on IPFS). Chained provenance, where the prior is the proven output of
  another program (hypercerts root as trust-graph prior), is the strongest version and is native to
  the multi-program platform.

**Normalization.** The prior is L1-normalized, so whale mass is zero-sum against everyone else. A
single $10M hypercert would own the prior uncompressed. Standard toolkit: log1p, winsorize at ~p99,
rank/quantile transforms. The adversarial subtlety: **every concave transform makes k split
identities worth more than one** (log x < k·log(x/k)). So: rank/quantile for adversarially
inflatable magnitudes (funding amounts; more raw metric buys nothing past top ranks), log+cap for
evaluation-derived signals, and pair concave compression with split-resistant identity (a
hypercert's evaluated impact can't be retroactively split; PPR further dilutes split identities via
reduced per-identity out-reach). The transform must be named in the committed params so "these
weights = source root X under transform T" is checkable, not trust-me.

## 7. What we are *not* doing, and why

- **Genesis attestations** (synthetic attestations from a genesis key, weight = score): zero
  algorithm change and works today, but semantically dishonest (attestations mean "I vouch"),
  makes the genesis key a permanent super-node, and flattens every seeded account to distance 1.
  Acceptable only as a demo stopgap.
- **Post-hoc blending** (`final = α·pagerank + (1−α)·imported`): imported standing doesn't
  propagate to people the standing-holders vouch for; a static airdrop, not a trust root.
- **Negative priors** (Anti-TrustRank distrust): real literature exists, but EigenTrust/OpenRank
  clip negatives for good reasons; out of scope for v1.
- **Recursive epoch-carry priors**: see §5; lock-in risk outweighs momentum benefit.

## 8. Open questions before an implementation GOAL

1. **Governance of the prior mixture.** λ values and source roots are operational-timelock params;
   a captured operator could rotate in a malicious prior. ZK_ARCHITECTURE already flags seed-set
   capture; a continuous prior widens that surface. Do per-source λ caps belong in the constitution
   (verifier-checked bounds) rather than params?
2. **Fixed-point spec for the mixture.** Weight truncation at tiny priors, the strictly-positive
   floor guarantee, and deterministic normalization of the witness blob all need the same rigor as
   the existing encodings (golden vectors across Rust/guest/Solidity/TS).
3. **Fade-parameter details.** Exact definition of trusted mass S from the previous root (which
   attestations count, at what weights), behavior at epoch 0, and adversarial analysis of the
   schedule with the same seriousness we gave the arming program.
4. **Unclaimed-identity policy.** Do unclaimed DID-keyed entries hold their teleport mass
   indefinitely, decay, or park in a claimable pool? Interacts with the fade schedule.
5. **Rotation batching.** This change rotates all three program vkeys; which other pending guest
   changes should ride the same constitutional rotation?

## 9. Source index (external)

TrustRank: vldb.org/conf/2004/RS15P3.PDF · Jeh–Widom linearity: infolab.stanford.edu/~glenj/spws.pdf ·
Damping functions: chato.cl/papers/baeza06_general_pagerank_damping_functions_link_ranking.pdf ·
Topic-Sensitive PageRank: cs.cmu.edu/~christos/courses/826-resources/PAPERS+BOOK/Haveliwala_www2003.pdf ·
EigenTrust: nlp.stanford.edu/pubs/eigentrust.pdf · Topical TrustRank: dl.acm.org/doi/10.1145/1135777.1135792 ·
Anti-TrustRank: i.stanford.edu/~kvijay/krishnan-raj-airweb06.pdf ·
Gleich sensitivity: cs.purdue.edu/homes/dgleich/publications/gleich 2007 - pagerank derivative and sensitivity.pdf ·
OpenRank EigenTrust docs: docs.openrank.com/reputation-algorithms/eigentrust ·
OpenRank Farcaster: docs.openrank.com/integrations/farcaster/ranking-strategies-on-farcaster ·
OpenRank TEE protocol: docs.openrank.com/the-reputation-stack/openrank-protocol, github.com/openrankprotocol/openrank-tee ·
Passport critique: decentralised.co/p/passport-please · Gitcoin GG20 strategy: gov.gitcoin.co/t/our-sybil-resistance-strategy-for-gg20/18524 ·
GG23 model-based detection: human.tech/blog/human-passport-x-gitcoin-grants-defending-gg23-with-model-based-sybil-detection ·
SourceCred wind-down: discourse.sourcecred.io/t/sourcecred-the-organization-is-winding-down/1383 ·
CredSperiment ethnography: ellierennie.medium.com/an-ethnography-of-sourcecreds-credsperiment-396a81efe355 ·
Bayesian average / IMDb WR: en.wikipedia.org/wiki/Bayesian_average · Jøsang Beta Reputation: people.cs.vt.edu/~irchen/5984/pdf/Josang-BECC02.pdf ·
Winsorizing: en.wikipedia.org/wiki/Winsorizing · Quantile normalization: search.r-project.org/CRAN/refmans/bestNormalize/html/orderNorm.html
