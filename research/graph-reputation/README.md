# Graph-reputation simulation record

This directory preserves the graph-reputation research spike and its provenance. It is not a
shipped scoring program. The explorer's advisory recurrence is integer-only and lives in
`packages/indexer/src/graph-reputation.ts`; the independent Rust reproduction is in `core/`.
Both are fixed by `golden/graph-reputation.json`, which their test suites read directly.

The former production-looking paths were retired together: `core/` moved from `crates/`, the
golden moved from `tests/golden/`, and the design/operation notes moved from `docs/build/` to
`docs/`. Keeping them together prevents the spike from being mistaken for an SP1 program while
retaining the cross-language evidence.

The simulations establish the V1 advisory boundary:

- a disconnected reciprocal cartel receives zero without trusted ingress;
- 10% trusted ingress produces 16.322527457003253% cartel mass (16.3225% displayed);
- unused and dangling referral mass returns to the sparse prior;
- reciprocal rings cannot bootstrap without ingress;
- a compromised or omitted root is visible through leave-one-root-out L1 sensitivity;
- shared family, controller, publisher authority, and method remain concentration signals rather
  than independent votes;
- authority/configuration rotation, revocation, expiry, same-epoch circularity, and unavailable
  history fail closed;
- a non-root lineage is recommendation-ineligible during its 30-day probation.

These results support advisory inspection only. They do not justify automatic weight adjustment.
