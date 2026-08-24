# Nostr workspace pre-pilot security review

> Internal review record. This page is not part of the public product documentation.

Status: local implementation review complete; independent S5 review and pilot-data review open.
This document is not an external security sign-off.

## Reviewed boundaries

| area | evidence and conclusion |
| --- | --- |
| canonical encodings | TGNW length framing, NIP-01 JSON/id rules, params, journal, score blob/CID, Merkle leaves, and skip folds have Rust/guest/Solidity/TypeScript golden parity and mutation tests |
| signatures and delegation | every event uses BIP-340 verification; relay roster and audit credentials are separate; OA owner/key/kind/window constraints have signed adversarial fixtures |
| completeness and omission | Option A re-folds `1..=count` and requires relevant-event coverage; Option C binds ordered event ids/count/head; missing bytes invalidate a head and unavailable selected heads enter closed rule-Phi outcomes |
| bounds and spend | decoder/allocation limits are consensus checked; exporter applies stricter pilot limits; operator uses authenticated exact-work preflight and top-band pricing before proof spend |
| secret/scoped content | collection credentials are host-only; public journal/blob contain no event bodies; index/API expose redacted archive commitments and actor/binding provenance only |
| cross-program isolation | distinct program/output domains, registered instance tuple, pinned verifier/vkey/params, journal `instanceDomain`, typed index/frontend routing, twin replay rejection, and composition provenance capture all fail closed |

## Counterexamples found during implementation review

1. The self-log exporter originally selected the first matching authority record. A corpus holding
   historical and current heads could therefore export the stale count. It now selects the unique
   greatest count and rejects conflicting metadata at that count; the epoch-2 fixture is the
   regression.
2. The indexer originally expected kebab-case archive variant strings. Rust serializes
   `BuzzAuditV1` and `SelfLogV1`; ingestion now requires those exact wire values and rejects aliases.
3. The Merkle event dispatcher passed raw output bytes to the Hypercerts decoder and omitted them
   from the Nostr decoder. Typechecking exposed the arity inversion; the bytes now reach the Nostr
   canonical SHA/CID validator.
4. A toy indexer test did not cover the real dual-domain tree. Production sidecar validation is now
   a pure shared boundary exercised over the frozen golden and over both live S4 epochs.

## Accepted or open design limits

- A live `CARRIED` outcome cannot currently be produced by the safe ingress rules: equal counts are
  rejected on chain and lower-count fallback is forbidden by H-5. The implementation keeps the
  defensive core regression and uses `DROPPED` in the live withheld-C flow. This is recorded in
  [`research/DEVIATIONS.md`](../../../research/DEVIATIONS.md), entry 29.
- Trust-compose v1 captures authenticated Nostr source provenance/root but does not reinterpret the
  bytes32 Nostr score blob as an address distribution. A projection/version change is required;
  entry 30 records the boundary.
- Option A proves completeness relative to the pinned community exporter, not relay honesty.
  Option C is self-committed but admitted-relayer gated for on-chain availability.
- Member-scoped archive availability is operational, not proven by the SNARK. The S5 clean-room
  reproduction and archive-loss drill remain mandatory.

## Independent review handoff

The S5 reviewer must re-check the pinned Buzz compatibility patch and source assertions, all
canonical encoders, signature/delegation call sites, omission paths, cap arithmetic, log/secret
redaction, deployment roles, program/output-domain tables, and the real pilot artifacts. Findings,
reviewer identity, reviewed git SHA, disposition, and residual risk acceptance belong in the pilot
record; “local tests passed” is not an acceptable substitute.
