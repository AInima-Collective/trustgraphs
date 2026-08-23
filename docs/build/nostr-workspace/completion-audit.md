# Nostr workspace completion audit

Audit date: 2026-08-19. This record distinguishes locally demonstrated implementation from the
member-scoped pilot work that requires people, credentials, infrastructure, and review authority
outside this checkout.

## Stage status

| stage | local status | authoritative evidence |
| --- | --- | --- |
| S0 — protocol freeze | complete | The pinned profile and compatibility patch are documented in the [fixture ADR](../../../tests/fixtures/nostr/buzz/a362fecc2389955f942c9581bdfeba379ab115b3/README.md). Source-derived live exports, serializer cases, adversarial bundles, measured caps, cycle/PGU evidence, exact J1/binding/self-log grammars, and deviations are checked in beside it. |
| S1 — envelope 2 | complete | [`crates/nostr-envelope`](../../../crates/nostr-envelope) is the isolated canonical envelope implementation. Its native conformance tests and the detached [`conformance` guest](../../../zk/nostr-program/program/src/conformance.rs) cover TGNW, Buzz audit prefix, self logs, NIP-01/BIP-340, OA, roster, replacement/deletion, coverage, caps, and mutation failures. |
| S2 — scoring and parity | complete | [`crates/nostr-workspace-core`](../../../crates/nostr-workspace-core), the detached [`nostr_workspace` guest](../../../zk/nostr-program/program/src/nostr_workspace.rs), the [golden vector](../../../tests/golden/nostr-workspace.json), Solidity codec/tests, and the TypeScript reduced-tier port reproduce the frozen params, journal, skips, leaves, root, blob, and CID. The 2026-08-23 hardening batch rebuilt this guest at vkey `0x00a1d93b8f040284bf86841331064987bfb9fc282075963f153ec75ca87c1eed`; exact parity is rerun before release. |
| S3 — witness and archive operations | complete locally | The witness implementation is [`zk/prover/src/witness/nostr.rs`](../../../zk/prover/src/witness/nostr.rs); the command group is [`zk/prover/src/programs/nostr_workspace.rs`](../../../zk/prover/src/programs/nostr_workspace.rs). [`witness-operations.md`](./witness-operations.md) specifies inspect/export/anchor/assemble and archive repair. The Anvil smoke gate proves immutable export, independent reconstruction, offline execution/proving, idempotency, and pre-spend refusal paths against the pinned fixture. |
| S4 — platform integration | complete locally | The deployment script, node-kind policy, verifier/snapshot/registry wiring, top-band vault pricing, durable operator recovery, authenticated score-program ingestion, Nostr schemas and [migration 0005](../../../packages/indexer/migrations/0005_curved_golden_guardian.sql), paginated content-free APIs, authenticated frontend discovery/detail view, composition capture, documentation, and twin/domain rejection are present. [`nostr-workspace-two-epoch-e2e.sh`](../../../scripts/nostr-workspace-two-epoch-e2e.sh) lands two distinct roots through the production surfaces with only the SNARK gateway mocked. |
| S5 — non-synthetic pilot | **open; not run** | [`pilot.md`](./pilot.md), [`hardening.md`](./hardening.md), and [`security-review.md`](./security-review.md) are handoff/checklist records, not pilot evidence or independent sign-off. The clean-room and drill scripts are ready but have not been run by external authorized holders against a non-synthetic member-scoped workspace. |

## S4 seam audit

- The `InstanceRegistry` event fold owns the immutable `(program, output domain, snapshot)` identity.
  Unknown and conflicting bindings fail closed before ingestion or API service.
- `GET /score-programs?program=nostr-workspace` is bounded and paginated. The frontend directory
  accepts only runtime-parsed Nostr program provenance from that catalog and links the authenticated
  snapshot to the typed score view; there is no static Nostr instance list.
- Nostr metadata and score rows have explicit Drizzle schema and migration coverage. Regenerating
  migrations after `0005_curved_golden_guardian.sql` reports no schema changes.
- The API reconstructs the complete dual-domain Merkle root before serving proofs, rechecks every
  historical row against the current authenticated binding, and rejects scoped-content fields.
- Trust-compose captures exact Nostr program/verifier/vkey/params/root provenance but deliberately
  refuses to relabel its bytes32 member domain as an address distribution. This accepted boundary is
  recorded in [`research/DEVIATIONS.md`](../../../research/DEVIATIONS.md), entry 30.
- Strict Clippy is satisfied through manifest lint policy where frozen guest source spellings must
  remain unchanged. Same-path before/after rebuilds found all nine existing/detached guest ELFs
  byte-identical; see [`local-testing.md`](./local-testing.md#vkey-safe-lint-policy).

## Locally reproduced facts

| item | epoch 1 | epoch 2 |
| --- | --- | --- |
| output root | `0xc4de11709437734678cc026014c6162ffb7cda01b5aac93c8ba5a8091bd96678` | `0xf262dbe32bec8dc313f731ba1276cf4959d852eb36b9715461720a213171462f` |
| score CID | `bafkreia7b4rsfrkctdvwvhtmp4chtj23lsekxccdlzwc7himq4hvu2rsx4` | `bafkreid7z7on33y5y3j3xlczar2ng35egxcvzzwr2gwtdbg2jrvpbgqwse` |
| frozen execution | 6,845,293 cycles | 8,477,214 cycles |

The exact repository verification matrix was green at this audit, including formatting, strict
Clippy, all-feature Rust tests, the detached Nostr workspace, exact Nostr parity, 639 Forge tests,
90 indexer tests plus lint/typecheck, frontend tests/lint/build, and the main Anvil `task e2e`.
The separate Nostr two-epoch and local hardening gates were also green. These results demonstrate
S0–S4 locally; they do not substitute for S5.

## S5 authority and evidence still required

S5 needs a supported non-synthetic Buzz workspace and RPC/archive access, a second authorized
archive holder, production alert destinations, an independent security reviewer, and—when the
configured SP1 environment supports it—a real Groth16 prover. The pilot must land two consecutive
epochs, keep at least 2× margin under every cap, reproduce one landed epoch byte-for-byte from a
clean checkout, exercise the listed recovery/alert paths, preserve the full skip preimages under the
correct ACL, and record named review/risk acceptance. Until those records exist, the program is
accurately described as **built; pilot pending**, and the overall goal is not complete.
