# Local Testing — the hypercerts program

How to exercise the hypercerts instance (atproto records → envelope-1 proof → trust-weighted
`{node → score}` root) locally, from fastest to fullest. The **EAS/trust-graph** local-testing
guide is [`/LOCAL_TESTING.md`](../../LOCAL_TESTING.md); operations for a real deployment are in
[`RUNBOOK.md`](./RUNBOOK.md); third-party epoch reproduction is [`REPRODUCE.md`](./REPRODUCE.md).

Prereqs are the same as the main guide (Foundry, Rust, `jq`, the SP1 toolchain via `sp1up`), plus
nothing else — the seeded fixture is committed, so no PDS or network access is needed for any of
the checks below.

> **Small-box note (applies to everything here):** run executor-only commands with
> `SP1_PROVER=mock`. The `cpu` backend (the `.env` default) eagerly allocates a ~5 GiB prover
> machine that `execute`/`vkey`/`paramshash` never use and OOMs small machines. `mock` changes
> nothing about the executor or the guest==native byte-assert. Real proving needs
> `SP1_PROVER=network` (+ `NETWORK_PRIVATE_KEY`) or a 16–32 GiB box.

## 1. Quick check — one command

```bash
task e2e            # or: bash test/e2e/run.sh
```

The e2e now runs **four stages** and the last one is the full hypercerts pipeline on a throwaway
anvil: deploy the lane-2-only instance (`EmptyLaneAccumulator` + `AnchorRegistry` +
`SP1JournalVerifier` + `MerkleSnapshot`), register the fixture's two DIDs through the registrar
gate, anchor both repo heads, `trigger()` (checkpoints both lanes), prove the two-repo fixture
through the guest (`guest == native ✓`), `submitProof`, and assert the root + `skippedDigest`
landed and the instance resolves via `InstanceRegistry`. Look for **`E2E HYPERCERTS PASS`**.

The SNARK check is mocked at the gateway seam (`MockSP1Gateway`) — everything else (journal
binding, vkey pinning, envelope-1 verification in the guest, checkpoint wiring) is the production
path. See the main guide's full-stack section for real-gateway proving.

## 2. Test suites (no chain)

```bash
cargo test -p hypercerts-core   # decode + decimal + binding + E1–E4 semantics/anti-gaming
                                # + full-pipeline + two-sided multi-repo fixture tests
cargo test -p envelopes         # envelope 1: CAR/commit/PLC/MST + 12-test conformance suite
forge test --match-path "test/unit/golden/*"   # incl. HypercertsGoldenVectors (Solidity parity)
cd frontend && pnpm test        # TS parity + the reduced-tier recompute from indexed edges
```

The anti-gaming battery lives in `packages/hypercerts-core/tests/semantics.rs` (self-evaluation
inert, padded contributor lists dilute, forged acks in the wrong repo inert, allowlist misses
skip, satellite discount) and `tests/two_sided_fixture.rs` (cross-repo response/ack boosts with
exact arithmetic).

## 3. Guest checks (the parity layer)

```bash
task zk:execute PROGRAM=hypercerts    # guest == native byte-assert over the seeded fixture
task zk:parity  PROGRAM=hypercerts    # the full aggregate: vectors drift-gate + all four layers
task zk:vkey    PROGRAM=hypercerts    # ⚠ vkeys depend on the exact toolchain build — see PROGRAMS.md
```

First guest build takes minutes; afterwards seconds. If you edit `packages/*`, force a guest
rebuild (`sp1_build` doesn't watch path deps): `cd zk/program && cargo prove build`, then
`touch zk/prover/build.rs` before the next host build.

## 4. Manual local instance (pick-apart version of the e2e stage)

```bash
anvil --silent &                                  # throwaway chain
PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# inputs from the committed fixture: writes hc_input.json, prints nodeIds + heads to anchor
cargo run -p hypercerts-core --example emit_fixture_input hc_input.json

# deploy the whole instance in one labeled script (mock gateway on a dev chain)
GW=$(forge create test/mocks/MockSP1Gateway.sol:MockSP1Gateway --rpc-url http://127.0.0.1:8545 \
  --private-key $PK --broadcast --json | jq -r .deployedTo)
SP1_VERIFIER_GATEWAY=$GW \
HYPERCERTS_VKEY=$(cd zk/prover && SP1_PROVER=mock cargo run -q --release -- hypercerts vkey) \
HYPERCERTS_PARAMS_HASH=$(cd zk/prover && SP1_PROVER=mock cargo run -q --release -- hypercerts paramshash ../../hc_input.json) \
forge script script/DeployHypercertsInstance.s.sol:DeployHypercertsInstance \
  --sig "run(string)" local --rpc-url http://127.0.0.1:8545 --private-key $PK \
  --broadcast --skip-simulation
# then: registerNode(nodeId, 1) + anchor(nodeId, 1, head, 0x0) per printed line,
# rewrite hc_input.json's anchors with the REAL block timestamps (the guest re-fold must match
# the checkpointed anchorAcc), trigger(), prove, submitProof — the exact command sequence is
# the `hypercerts` stage of test/e2e/run.sh; crib from there.
```

`execute`/`prove` write `hypercerts_blob.json` (the `{nodeId → score}` blob) and
`hypercerts_skips.json` — the full `skippedDigest` preimage, i.e. every rule-Φ and record-level
skip the guest committed. The fixture always produces one entry (alice's self-evaluation, kept
in the fixture deliberately as a live anti-gaming check).

## 5. Against real atproto data (network required)

```bash
# fetch + archive a real repo into an offline-reproducible witness bundle:
cd zk/prover && cargo run --release --features witness-atproto -- \
  witness fetch --did did:plc:ewvi7nxzyoun6zhxrhs64oiz
# verify a repo through the envelope-1 pipeline in the SP1 guest (cycle counts printed):
SP1_PROVER=mock cargo run --release -- atproto-conformance execute \
  --car .witness-archive/<did>/<rev>.car --plc .witness-archive/<did>/plc-*.json \
  --collections app.bsky.graph.follow
```

## 6. Regenerating the fixture

The two-repo seeded fixture (alice + bob, all seven v1.1.0 collections, a real `link.evm`
signature) is generated by `spike/hypercerts-fixture/gen/gen.mjs` against a real in-process
PDS + PLC (`@atproto/dev-env`). DIDs/keys are random per run, so regenerating means re-pinning
the consumers listed in `spike/hypercerts-fixture/fixtures/README.md` — don't regenerate unless
you're changing the fixture's content.

## Troubleshooting

- **`execute` gets OOM-killed** → you're on the `cpu` backend; prefix `SP1_PROVER=mock`.
- **`succinct` toolchain missing** (fresh container) → `curl -L https://sp1up.succinct.xyz | bash
  && sp1up --version v6.3.1`.
- **`submitProof` reverts with a digest mismatch** → your input's anchors don't re-fold to the
  checkpointed `anchorAcc`: wrong order, wrong timestamps (must be the real `block.timestamp` of
  each `anchor()` tx), or a missing anchor. The exporter-style self-check in the e2e stage shows
  the jq rewrite that fixes timestamps.
- **A node scores zero unexpectedly** → check `hypercerts_skips.json` first; reasons are the
  closed enum in `hypercerts_core::semantics::skip_reason` (+ rule-Φ CARRIED/DROPPED from
  `pagerank_core::skip_reason`).
