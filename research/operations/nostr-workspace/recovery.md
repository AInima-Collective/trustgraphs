# Nostr workspace recovery

> Internal operations guide. This page is not part of the public product documentation.

Recovery never changes consensus inputs to make a failed epoch pass. Start from the last durable
artifact and repeat the next idempotent boundary.

| failure | stop/recover action |
| --- | --- |
| audit lag/gap, missing event, relay-key or schema mismatch | do not export or anchor; repair Buzz/audit health, take a new consistent snapshot, and inspect again |
| archive lost before anchoring | another authorized holder re-exports; bytes and manifest must match, otherwise abandon that head |
| archive lost after anchoring | reconstruct only the exact committed TGNW; verify SHA-256/CID and production envelope before restoring it under the same ACL |
| equal count with different head/commitment | treat as equivocation/misconfiguration; the anchor command fails and must not increment count |
| oversized inner work | do not prove; wait for a reviewed params/new-instance change—never trim committed relevant events |
| incomplete RPC log range | retry chunked reconstruction from the configured deployment block; assembly writes nothing until the fold equals the checkpoint |
| invalid or missing newest C bundle | omit unavailable bytes honestly; the guest records `DROPPED` and H-5 prevents stale resurrection |
| execute/native mismatch | quarantine the binary/input and stop; do not request a proof |
| proving interruption | rerun from the byte-identical input and authenticate public values/vkey; no Buzz or anchor credential is needed |
| publication interruption | re-add the exact score blob; require the returned CID and gateway bytes to match before submission |
| reverted submission | read checkpoint, verifier, params, instance domain, and last-applied state; retry only the identical journal tuple if it is still current |
| index/API interruption | replay accepted on-chain provenance and the committed blob/sidecars; root reconstruction and score-program authentication must pass before rows are served |

Disable a compromised instance by revoking `ANCHORER_ROLE` immediately, then use constitutional
governance to rotate the verifier only for a soundness incident. The v1 params authority is
immutable: relay key, community, archive policy, limits, or semantic changes require a reviewed
replacement instance and a new `InstanceRegistry` row, not an in-place partial mutation.

Keep these separately durable: source-profile and deployment records, every immutable manifest and
TGNW, assembly input/receipt, proof/public values, canonical score blob, skip preimage, redacted
metadata, publication receipts, and accepted transaction/provenance. Credentials and scoped event
content never enter public artifacts or logs.

Rehearse these paths locally with [`hardening.md`](./hardening.md), then repeat them against the
actual pilot with real alert-delivery evidence. Local synthetic success is not pilot sign-off.
