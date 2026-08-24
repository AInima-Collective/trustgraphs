# Nostr workspace operator runbook

> Internal operations guide. This page is not part of the public product documentation.

This is the program-level runbook for a `nostr-workspace` instance. Privileged Buzz collection,
immutable TGNW archives, anchoring, and offline input assembly are specified step by step in
[`witness-operations.md`](./witness-operations.md); recovery is in
[`recovery.md`](./recovery.md).

## Frozen identity

| item | value |
| --- | --- |
| program | `keccak256("nostr-workspace")` |
| output domain | `keccak256("trustgraphs.output.nostr-member.v1")` |
| current rebuilt vkey | `0x00a1d93b8f040284bf86841331064987bfb9fc282075963f153ec75ca87c1eed` |
| pilot params hash | `0xaf83d14a8b8fe347e8a3d1465ce148ccd03b2bc2e32a6f53e6f1f6b97826a2bd` |
| envelope/node kinds | envelope `2`; Nostr DID `2`; Buzz community `3` |
| Buzz source profile | `a362fecc2389955f942c9581bdfeba379ab115b3` plus the pinned compatibility patch |

Never infer a program from a label, CID, JSON shape, or contract name. The operator, indexer, and
frontend authenticate the `InstanceRegistry` row, verifier code/vkey, params hash, and output-domain
binding.

## Deploy an instance

Build the detached guest and witness-enabled host with `task zk:build`. Deploy the chain-global
`InstanceRegistry` first, then set the values consumed by the labeled deployment script:

```sh
export SP1_VERIFIER_GATEWAY=0x...
export NOSTR_WORKSPACE_VKEY=0x00a1d93b8f040284bf86841331064987bfb9fc282075963f153ec75ca87c1eed
export NOSTR_WORKSPACE_PARAMS_HASH=0xaf83d14a8b8fe347e8a3d1465ce148ccd03b2bc2e32a6f53e6f1f6b97826a2bd
export NOSTR_COMMUNITY_NODE_ID=0x...
export NOSTR_MEMBER_NODE_IDS=0xagentNode,...
export INSTANCE_REGISTRY=0x...
export NOSTR_MAX_TOTAL_INPUTS=200000
export NOSTR_EPOCH_LENGTH=0

forge script contracts/script/DeployNostrWorkspaceInstance.s.sol:DeployNostrWorkspaceInstance \
  --sig 'run(string)' pilot --rpc-url "$RPC_URL" --private-key "$DEPLOY_KEY" --broadcast
```

The script deploys `EmptyLaneAccumulator → AnchorRegistry → SP1JournalVerifier → MerkleSnapshot`,
performs both reciprocal bindings, registers node kinds, installs the immutable v1 params authority,
and registers the exact tuple. Before the first accepted root, constitutional governance must call
`enableStateProvenance()` if this instance will be captured by composition.

Re-read every emitted address from `InstanceRegistry`, `programVKey()`, `paramsHash()`, both binding
directions, node registrations, roles, capacity, and provenance status. Production key separation is
mandatory: constitutional control, operational params control, and the admitted anchorer are not one
hot key.

## Run one epoch

1. Inspect Buzz read-only state and require all health/cap gates.
2. Export Option A and every enabled Option C head to durable member-scoped storage. Re-export on a
   second authorized archive holder and byte-compare the bundle and redacted manifest.
3. Anchor only a locally verified immutable manifest. Retrying the exact head is an idempotent no-op;
   a changed preimage or stale count is a hard failure.
4. Trigger the snapshot at the scheduled boundary.
5. Reconstruct every `HeadAnchored` log through that checkpoint and assemble `GuestInput` with only
   the available selected archives. Preserve `input.json` and its assembly receipt.
6. In a credential-free environment, execute first and require `guest == native`; then request a
   Groth16 proof. Authenticate the vkey and all printed journal fields.
7. Publish the exact `nostr_workspace_blob.json` under its guest-committed raw CID. Verify at least
   the configured number of gateways return byte-identical data before submission. Keep
   `nostr_workspace_skips.json`, metadata, journal, and the assembly receipt under the archive ACL.
8. Call `submitProof` with the printed root, SHA-256, CID, total, skip digest, recipient, and encoded
   proof. Confirm the accepted checkpoint provenance, score-program row, index/API root, and browser
   proof reconstruction before declaring the epoch healthy.

The durable operator recognizes `Program::NostrWorkspace`, prices it in the conservative top band,
authenticates exact work limits before proving spend, and journals witness/proof/publication state.
Restarting never invents a new witness or submission tuple.

## Product and composition checks

The Nostr API is paginated (maximum 200), serves member/agent/owner/binding provenance, Merkle proofs,
trust class, access policy, skip summary, and reduced-recompute status, and never serves event body
content. The frontend runtime parser re-authenticates the exact program/output domain and every score
proof. `/networks` discovers Nostr rows only through the paginated
`/score-programs?program=nostr-workspace` catalog, whose entries are sourced from non-conflicting
`InstanceRegistry` bindings; the row links to the typed `/nostr-workspaces/<snapshot>` view.

A `CompositionSourceAdapter` can capture the accepted Nostr checkpoint with its exact program, vkey,
params, verifier provenance, and unified root. Trust-compose v1 does not reinterpret the bytes32
member blob as an address blob; see the explicit boundary in
[`research/DEVIATIONS.md`](../../../research/DEVIATIONS.md).

## Local acceptance and pilot

Run `task zk:nostr-workspace-e2e` for the two-epoch production-surface rehearsal, then the matrix in
[`verification.md`](./verification.md). This uses a mock only at the SNARK gateway seam. S5 still
requires a member-scoped non-synthetic workspace, an authorized clean-room reproduction, operational
failure drills, focused review, and one real Groth16 proof when a suitable local/network prover is
available. The open pilot record and exact handoff procedures are in [`pilot.md`](./pilot.md), with
local drill coverage in [`hardening.md`](./hardening.md) and the pre-pilot review in
[`security-review.md`](./security-review.md).
