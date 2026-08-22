# Graph lineage operations runbook

## Deploy and configure

Deploy one registry against the same canonical `InstanceRegistry` the score catalog indexes:

```sh
forge script contracts/script/DeployGraphLineageRegistry.s.sol:DeployGraphLineageRegistry \
  --sig 'run(string)' "$INSTANCE_REGISTRY" \
  --rpc-url "$RPC_URL" --private-key "$FUNDED_KEY" --broadcast
```

Set `GRAPH_LINEAGE_REGISTRY_ADDRESS_31337` or `GRAPH_LINEAGE_REGISTRY_ADDRESS_10` for the indexer,
and `GRAPH_LINEAGE_REGISTRY_ADDRESS` while generating frontend config. An absent address disables
only lineage routes. Restart/replay Ponder from at or before the deployment block and confirm
`/graph-lineages/lineages` responds.

## Register or rotate a lineage

Before registration, verify the instance exists and has a nonzero params authority. The live
controller owner (or the controller itself when `owner()` is absent) calls `registerLineage` with
nonzero family, method, scope, and identity-domain hashes. Store the returned lineage and
configuration IDs; do not derive identity from the display name, snapshot, or root.

After any controller, owner, program, contract-set, or params rotation, old claims are already
inactive. The new live authority calls `syncConfiguration` with the reviewed classifiers. A no-op
sync reverts, versions never overwrite history, and accepting a new authority is therefore
explicit.

Publish an exact epoch with `publishEpoch(lineageId, checkpointId)`. The snapshot must have
accepted-state provenance enabled. The call refuses a checkpoint whose pinned params or verifier
does not match the current configuration.

## Issue, replace, and revoke

Use a separate issuer/scope sequence. The first sequence is 1 and every later record increments by
exactly one. A claim replacing the current issuer/subject/scope/kind head must name that exact head
in `supersedes`; replay or an ambiguous replacement reverts.

Set a finite interval no longer than 90 days. Use `evidenceDigest = 0` only when evidence is
intentionally mutable and review the corresponding UI warning. A referral must have positive
weight and total active weight for the issuer/scope must remain at or below `1e18`. Do not
normalize away the returned unused mass. Future-dated records reserve their weight across their
validity window; overlapping schedules above the ceiling revert at issuance.

To revoke, the current live issuer authority calls `revokeEndorsement` with a nonzero reason or
evidence commitment. Revocation is permanent. A later claim uses a new sequence and explicitly
supersedes the prior head; old records are never deleted.

## Consumer checks

Fetch paginated history from `/graph-lineages/endorsements`. Before using an edge, require status
`active` from the canonical contract-confirmed API or call:

```text
endorsementStatus(endorsementId, expectedScope, expectedSubjectConfigurationId)
```

Reject `verification-unavailable`. Never put integrity, methodology, agreement, or warning rows in
referral adjacency. Show evidence mutability and family/method/controller/authority overlap next to
every recommendation. No output of this subsystem authorizes changing live trust-compose weights.
