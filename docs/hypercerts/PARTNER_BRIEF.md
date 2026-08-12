# Hypercerts × TrustGraph — Partner Brief (asks & flags)

**To:** the Hypercerts team · **From:** the TrustGraph pilot team · **Date:** 2026-07-15
**Context:** [`HYPERCERTS_ATPROTO_PLAN.md`](../../research/HYPERCERTS_ATPROTO_PLAN.md) §9. The
system this brief supports is **built and tested end-to-end**: your
AT Protocol records (all seven v1.1.0 collections) are verified inside an SP1 zero-knowledge
proof — repo commit signatures, did:plc key chains, MST completeness walks — and folded into a
trust-weighted `{node → score}` merkle root nobody has to be trusted to compute. A seeded
two-repo fixture already runs the full pipeline end-to-end on a local chain, including your
`link.evm` binding verified in-circuit against a real signature.

What we need from you, in priority order:

## 1. The CAIP-19 gap on `claim.activity` (schema change request)

Nothing in `org.hypercerts.claim.activity` links an atproto activity to its on-chain ERC-1155
hypercert. Scores therefore attach to the *atproto* artifact only. This does not block the
trust-graph pilot, but it blocks the day you want scores to gate anything token-side (curation,
rewards, marketplace ranking). **Ask:** add an optional `onchainRef` field (CAIP-19 asset id) to
`claim.activity`, or bless a companion record type. Additive, no consumer breaks; we will verify
and carry it through the proof the release after it ships.

## 2. PDS enumeration + firehose access (pilot-operational)

The pilot's registration gate is an allowlist of your PDS(es). We need: (a) the hostnames of the
PDSes your users' repos live on, (b) firehose/`getRepo` access at normal rate limits, and (c) your
explicit blessing for our **CAR archival** of the trust-relevant collections. On (c): archival at
observation time is a soundness duty, not a convenience — old atproto commits are *not
re-servable*, and a proven epoch must remain auditable from public data after your PDS has moved
on. The data is public; we still want this stated and agreed.

## 3. Lexicon change protocol (release coordination)

We pin `@hypercerts-org/lexicon =1.1.0` inside the proven statement. Additive changes are free.
But renaming or re-versioning any of the seven consumed collections (e.g. `.v2` NSIDs) is a
**change to the proven program and a verification-key rotation** on our side — a governance event
with lead time, not a dependency bump. **Ask:** release-notes lead time (2 weeks is comfortable) for any change
touching: `app.certified.graph.follow`, `badge.award`, `badge.response`, `app.certified.link.evm`,
`org.hypercerts.context.evaluation`, `context.acknowledgement`, `claim.activity`.

Two shape facts we measured against a live PDS that you should be aware of (they are now
load-bearing in our decoder): a stock PDS **rejects `validate: true`** for these NSIDs (unknown
lexicon), so records land unvalidated and our in-proof deterministic skip rules are the only shape
enforcement anywhere; and the `link.evm` EIP-712 domain (`IdentityLink`, version `1`, no
verifyingContract/salt) lives in your test suite rather than the schema JSON — we have pinned it
as wire format. If either is not what you intend, better to say so now than after the pilot.

## 4. Platform signing-key publication (v2 provenance)

Your README recommends platforms hold a long-lived keypair for record-level `signatures[]`. For
v1 we rely on the commit signature (sound without it); for v2 we would like to pin your platform
key(s) so record-level signatures upgrade edges from "PDS-attested" to "platform-witnessed".
**Ask:** publish the key(s) at a stable, documented location.

## 5. Acknowledgement UX (product, high leverage)

Attribution through evaluated work (`activity.contributors[]`) is worth **half** when the named
contributor has not acknowledged, and **double** when they have — being *named* is cheap; the
confirmed edge is the strong signal, and confirmation must come from the contributor's own repo
(we verify it two-sidedly). Concretely: "confirm your contribution" **is** "activate your
reputation." A visible nudge in your product flow directly increases how much of the graph's
value your users capture.

## 6. Optional: converge `link.evm` with `org.chainagnostic.verification`

Your call entirely; we verify either shape behind the same seam. Upstream convergence would help
the broader atmosphere more than it helps us.

---

**Seed list request (needed before the first epoch):** a curated list of initial evaluator/steward
DIDs (the `Params` seed set — governance-tunable afterwards). A dozen names is plenty.

**What you get, restated:** per-actor reputation and per-hypercert trust-weighted impact scores,
recomputable by anyone from public data, consumable on-chain via merkle proofs against a root that
a permissionless prover produced and a SNARK verified — plus a convenience API serving
`{nodeId, score, proof[]}` bundles so your apps never run infrastructure to use it.
