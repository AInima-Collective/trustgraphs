# Nostr workspace S5 pilot record

> Internal pilot record. This page is not part of the public product documentation.

Status: **not run**. S0-S4 use the pinned synthetic/local Buzz profile. No non-synthetic
member-scoped workspace, second authorized archive holder, production alert delivery, or real
Groth16/network proof is available in this workspace, so the release gate remains open.

## Freeze before the first anchor

Record the supported git SHA, Buzz SHA and compatibility-patch digest, chain, deployment
transactions/code hashes, registry tuple, verifier/vkey, program/output domains, params preimage and
hash, relay key, community id, roles, caps, epoch schedule, archive policy/holders, publication
quorum, alert destinations, and rollback/disable owners. No field may be filled from a label or
mutable `main` branch.

## Epoch evidence

For each of two consecutive non-synthetic epochs, retain under the correct ACL:

- consistent-source inspection and work counts with headroom calculation;
- immutable A/C manifests and TGNW hashes, anchor/checkpoint transactions, and assembly receipt;
- execution/proof request and verification receipts, all 12 journal fields, score blob CID, full
  skip preimage, redacted provenance, publication receipts, submission transaction, accepted state
  provenance, index root/API proof, and frontend proof check;
- evidence that epoch two exercised replacement, valid deletion/revocation, membership change,
  forum vote change, job lifecycle movement, and the documented live drop behavior; and
- measured work at no more than half each pilot ceiling (the required 2x operating margin).

At least one epoch must use a real Groth16 proof when the configured SP1 environment supports it.
If it does not, record the provider/resource constraint and keep the gate open.

## Independent authorized-holder reproduction

The second holder starts from a clean checkout and their own archive copy, reconstructs the
on-chain checkpoint, and runs:

```sh
scripts/nostr-workspace-clean-room-reproduce.sh \
  --rpc "$RPC_URL" --snapshot "$SNAPSHOT" --checkpoint "$CHECKPOINT" \
  --params /secure/archive/params.json --recipient "$RECIPIENT" \
  --manifest /secure/archive/a/manifest.json \
  --manifest /secure/archive/c/manifest.json \
  --expected-root "$LANDED_ROOT" --expected-cid "$LANDED_CID" \
  --out /secure/evidence/reproduction
```

The script refuses dirty source trees and ambient database/anchor credentials, assembles twice from
the archive plus chain, executes twice, authenticates the indexer boundary, and emits a redacted
`reproduction-evidence.json`. Preserve the holder identity/authorization assertion separately;
never check credentials or scoped event bodies into the public repository.

## Drills and sign-off

Run [`hardening.md`](./hardening.md) against the pilot systems, including real alert delivery, and
attach the evidence for every failure class. Complete the independent review in
[`security-review.md`](./security-review.md), resolve or accept every finding, and name the people
authorizing release. S5 exits only when these records point to immutable evidence and both epoch
roots reproduce without the original prover.
