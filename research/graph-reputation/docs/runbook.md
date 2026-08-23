# Graph-reputation research runbook

This records how to reproduce and inspect the advisory explorer experiment. It is not an operator
runbook for a shipped scoring or proof program.

## Operator checks

1. Confirm the graph-lineage registry and chain RPC are configured for the indexer.
2. Confirm the RPC supports the `finalized` block tag and historical contract reads.
3. Confirm each intended root has a live current configuration and an epoch accepted and published
   before the finalized cutoff.
4. Review active referral budgets for the requested scope. Issuer rows above `1e18`, duplicate
   pairs, or more than 256 active edges fail closed in the interactive endpoint (the portable core
   retains a 4,096-edge offline bound).
5. Record the returned cutoff, input commitment, result commitment, root prior, and warnings with
   any human policy decision that uses the recommendation.

Do not copy a recommendation into production defaults without an independent governance action.
The endpoint and UI intentionally provide no mutation or transaction path.

## Failure handling

- `400` means malformed roots, scope, weights, or a cross-chain/cross-registry root set.
- `422` means required history/liveness is unavailable or a deterministic bound/invariant failed.
- `503` means finalized RPC verification is unavailable. Retry only after the canonical provider
  is healthy; do not fall back to indexed-only or latest/unfinalized state.

Rotation, revocation, expiry, a new epoch, or referral supersession changes the active manifest.
Recompute and compare commitments instead of reusing an earlier response.

## Reviewer checklist

- Inspect root concentration and leave-one-root-out sensitivity.
- Inspect effective family mass rather than counting family/controller clones as independent.
- Inspect mutable evidence, authority/method/controller overlap, strongest ingress paths, and next
  expiry.
- Compare manual and recommended values explicitly and preserve the human decision separately.
