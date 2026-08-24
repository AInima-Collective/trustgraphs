# Nostr workspace hardening drills

> Internal test procedure. This page is not part of the public product documentation.

Run the local rehearsal from a witness-enabled release build:

```sh
scripts/nostr-workspace-hardening-drills.sh
```

This is synthetic pre-pilot evidence, not the S5 pilot. It deliberately reuses the pinned Buzz
fixture and `MockSP1Gateway`. The script proves that each failure stops at the intended boundary and
that retry/replay does not change consensus inputs:

| failure class | exercised boundary | required result |
| --- | --- | --- |
| audit lag/gap or missing audited event | exporter plus production envelope verifier | no archive/anchor; committed gap still rejected |
| relay-key/source-profile drift | exporter inspection | fail before archive or signing spend |
| invalid/equivocating self-log | newest-count exporter selection | reject equal-count disagreement; never fall back silently |
| archive loss/tamper | immutable archive verification and epoch-2 withheld C | tamper fails; unavailable newest C becomes the proven `DROPPED` preimage |
| oversized work | pilot/hard cap inspection and consensus params validation | refuse before proving; never trim events |
| proof failure | live mock gateway set to reject the exact proof | transaction reverts and state count remains zero |
| reverted submission recovery | gateway restored, identical journal/proof resubmitted | root lands once; same-instance replay then fails |
| publication interruption/restart | duplicate raw-CID add plus byte fetch | both adds return the committed CID and fetched bytes compare exactly |
| indexer replay | authenticated artifact-to-row boundary run twice per epoch | program/domain, bytes, actors, skips, and root reproduce identically |

The local suite checks stop/recovery semantics. It cannot demonstrate that a production paging
integration actually notified a human. For every pilot drill, preserve the alert identifier,
delivery timestamp, acknowledgement timestamp, responder, exact recovery command, and final
on-chain/indexed state in the pilot record.

Do not repair a drill by changing params, archive bytes, checkpoint, recipient, or journal fields.
The recovery table in [`recovery.md`](./recovery.md) is normative.
