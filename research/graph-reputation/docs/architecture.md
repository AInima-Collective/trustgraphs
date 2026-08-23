# Advisory graph-reputation architecture

Graph reputation recommends source weights; it is not a scoring program, policy governor, or
transaction builder. `POST /graph-lineages/recommendations` reads indexed lineage history,
confirms the finalized canonical chain state, runs a bounded deterministic fixed point, and returns
diagnostics. It has no database write and no trust-compose mutation path. This is a research
artifact, not a deployed or SP1-proven scoring program.

## Exact input boundary

The request supplies one bytes32 referral scope and one to sixteen explicitly trusted roots whose
positive weights sum to `1e18`. A uniform permissionless prior is never inferred. The indexer pins
the canonical finalized block and timestamp and one lineage registry and chain. The portable core
is bounded at 16 roots, 256 lineages, and 4,096 referrals. To keep the synchronous explorer API
responsive under leave-one-root-out recomputation, the interactive request is tighter: eight roots
and 256 active referrals.

Every included lineage must have a canonically live current configuration and an epoch whose
acceptance and publication blocks are both strictly less than the cutoff. The input binds the
lineage, configuration, epoch, family, method, controller, publishing authority, and creation time.
Every referral binds its ID, issuer and subject configurations, scope, weight, validity interval,
issuance block, evidence digest, and lifecycle state. Missing history or RPC verification fails
closed. Same-cutoff epochs and endorsements, wrong scope/version, expiry, revocation,
supersession, and rotation are excluded or reject a required root.

The canonical `TGRP` binary and its Keccak commitment make that captured state portable. The
`TGRR` result commits the input, iteration count, residual, score/rank, root-ingress matrix, and
effective family masses. TypeScript and Rust independently match the frozen vectors in
`research/graph-reputation/golden/graph-reputation.json`.

## Fixed-point recurrence

All values are integers at scale `1e18`; floating point is forbidden. The damping value is exactly
`0.85e18` and execution always performs 128 iterations. Each Hamilton allocation sorts remainder
ties by a canonical byte key and conserves exactly `1e18` mass.

At each iteration, 15% teleports to the sparse root prior and 85% propagates over positive referral
weights. A row may spend at most `1e18`. Unspent budget and a dangling row return to the sparse
prior rather than being normalized away. Root attribution is propagated alongside node mass, so
the response can show trusted ingress rather than only a scalar rank.

This boundary gives a disconnected permissionless cartel zero mass. In the accepted six-node
case, directing 10% of trusted root A's row into the cartel gives it
`163225274570032530 / 1e18`, or 16.3225% at the specified display precision.

## Eligibility and diagnostics

A positive score is not proof of independence. The response keeps family, method, controller,
publisher-authority, and mutable-evidence overlap visible, reports effective family mass, referral
budgets and expiry, strongest bounded paths, and leave-one-root-out L1 sensitivity. New non-root
lineages remain on 30-day probation. Curated roots are explicitly marked as root boundary entries.

Recommended weights are an exact Hamilton normalization over eligible positive-score lineages.
Manual weights are comparison data only. There is no apply button, signing request, default write,
or automatic adjustment. Any future automatic policy requires a separate reviewed issue with
caps, damping, churn controls, and an auditable capped-simplex rule.
