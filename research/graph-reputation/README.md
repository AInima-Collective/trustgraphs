# Graph-reputation simulation record

The production recurrence is integer-only and lives in `packages/indexer/src/graph-reputation.ts`; the
independent Rust reproduction is `crates/graph-reputation-core`. Both are fixed by
`tests/golden/graph-reputation.json`.

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
