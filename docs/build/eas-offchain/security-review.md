# Strict EAS off-chain independent review handoff

Status: local implementation review and adversarial tests exist; independent review is **not yet
performed**. This document defines scope and evidence expectations and must not be cited as a
security sign-off.

The reviewer receives the frozen git commit and guest ELF/vkey, official-SDK fixture generator and
corpus, deployed testnet addresses/verified source, params preimage, redacted service topology, raw
checkpoint inputs, proof receipts, chaos evidence, and the rollout ledger. Review the implemented
code and deployed bytecode/configuration, not this checklist alone.

## Required review boundaries

- `Envelope0PayloadV1` length/framing/canonical parsing, memory and body bounds, duplicate/revoke
  ordering, CID commitment, cache/gateway corruption, and host/guest equivalence;
- exact EAS v2 UID and typed-data compatibility, low-S EOA recovery, supported schema/data/profile,
  signed-time binding to the first committing anchor timestamp, and rejection of every unsupported
  variant;
- head EIP-712 chain/registry/schema/predecessor/count/commitment binding, first-use registration,
  domain separation, monotonic/fork behavior, relay replay/race handling, and administrative role
  separation;
- full newest-head history/prefix authentication, no omission discretion, anchor accumulator fold,
  checkpoint binding, deterministic mutation ordering, cross-lane tie/replacement/revoke semantics,
  and the no-resurrection invariant;
- registry delta arithmetic, payload/entry limits, `E0_ENTRY_WORK_UNITS`, checkpointed work,
  operator cycle limits, vault band agreement, overflow and one-past-cap behavior;
- relay body/compression/rate/origin controls, pin-before-anchor quorum semantics, simulation and
  receipt/reorg behavior, SSRF/endpoint configuration, credential/key/log isolation, abuse cost,
  denial of inclusion, and incident rotation;
- operator/indexer discovery, finality/reorg behavior, exact CID verification, cache poisoning,
  historical recovery, API provenance, UI action dispatch, unsupported companion programs, and
  lane-1 disabled-mode equality; and
- testnet deployment provenance: verified source, real gateway/vkey, roles, two independent keys and
  storage paths, feature flags, alert delivery, backup restoration, real proof receipt, and every
  rollout drill.

## Finding record

The report must name the reviewer/organization, reviewed git commit, deployed chain/addresses,
guest ELF digest/vkey, review dates, methods, limitations, and each finding with severity,
reproduction, affected boundary, fix commit, retest evidence, and final disposition. Critical and
high findings must be fixed and retested; they cannot be accepted for this gate. A medium is either
fixed and retested or has a named owner, concrete rationale, compensating controls, expiry/revisit
date, and explicit risk-acceptance evidence.

The rollout checker reads only the summary disposition. Preserve the full report and risk records
at immutable references; do not reduce a nuanced finding to a boolean without linking its evidence.
If the review changes bytes, semantics, work accounting, or the guest, return to protocol freeze,
rotate the vkey explicitly, and restart the affected test/soak interval.
