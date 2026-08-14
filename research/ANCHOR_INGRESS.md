# Anchor ingress admission and capacity

**Status:** Accepted and implemented for v1 (2026-08-13, issue #12)

## Decision

`AnchorRegistry` uses **governance-admitted relayers** and an **immutable anchor-ingress ceiling over
the live combined input count**.
Registration proves or admits an identity; it does not authorize that identity to consume proving
capacity. Only `ANCHORER_ROLE` may append an authenticated head. Each append checks, before changing
the fold,

```text
snapshot.accumulator().leafCount() + anchorCount + 1 <= maxTotalInputs
```

The registry binds exactly one reciprocal `MerkleSnapshot` and reads that snapshot's live
accumulator on every append. A pre-checkpoint lane-1 replacement therefore cannot make ingress,
checkpointing, vault pricing, and operator planning count different input sources.

`maxTotalInputs` is fixed at construction in the range `1..=200,000`. The upper bound comes from the
same Solidity `InputCapacity.MAX_TOTAL_INPUTS` used by `ProvingVault.MAX_PRICED_INPUTS`; Rust pins the
same value and retains its cross-language boundary test. A two-lane deployment must choose the cap
from its expected combined lifetime budget and separately gate or price lane 1. The registry can
reject only anchor writes: a later lane-1 append can consume the remaining headroom, so this is not
a substitute for lane-1 admission. The operator reads the published cap and alerts at 80%; legacy
registries without the getter fall back to 200,000.

Address nodes may still self-register, but this is deliberately harmless to proving size:
`register()` changes no accumulator word and grants no relayer role. Non-address registration stays
behind `REGISTRAR_ROLE`. Every admitted head, including non-address envelopes, must advance its
node's signed/semantic `count`, preventing a relayer retry from spending capacity on an exact replay.

## Trust and product tradeoff

This decision removes permissionless force inclusion. An admitted relayer can censor a valid head,
so production should grant `ANCHORER_ROLE` to multiple independently operated relayers and monitor
both `RoleGranted`/`RoleRevoked` and expected-head latency. Correctness still does not trust a
relayer: address heads retain their owner signature, and the guest re-verifies full envelope
semantics. The added trust is availability/inclusion, not the meaning of a proven root.

The trade is intentional for v1. A censorship-resistant ingress needs a resource that Sybil
identities cannot mint for free (a priced transaction, refundable bond, credential, or rate-limited
membership proof). None exists in the current product. Calling a free address registration
"Sybil-resistant" or retaining an unpriced force-inclusion path would leave issue #12 unresolved.

## Alternatives rejected

- **Per-node epoch limits alone:** one address is one free node, so an attacker can distribute the
  same volume across fresh addresses. It limits honest updates while leaving aggregate griefing.
- **Saturating the vault at band 3:** the operator refuses work above 200,000. Paying the top band
  for work the operator will not produce breaks the priceability invariant and only changes how the
  dead state is labelled.
- **A fixed ETH fee or bond now:** this can restore force inclusion later, but the fee recipient,
  refund/slash condition, chain-specific amount, sponsored users, and price-oracle policy are not
  specified. Guessing them in a security patch would create a new economic authority.
- **Monitoring only:** alerts do not stop an unaffiliated address from changing `anchorCount` and do
  not undo a chained-hash append.

## Mainnet attacker-cost analysis

Ethereum mainnet is the selected home chain. Focused Forge traces measure a first non-address append
at about 67,200 execution gas (about 88,200 including transaction intrinsic gas), and an address
append with `ecrecover` at about 71,500 execution gas (about 92,500 including intrinsic gas).
Repeated updates to already-warm/nonzero slots are cheaper; allowing for cold access in separate
transactions gives an order-of-magnitude exhaustion range of roughly 7–19 billion gas at the
absolute 200,000 cap, or about 7–190 ETH at 1–10 gwei. This is a **compromised admitted relayer**
scenario, not an outsider path. Operators should choose a smaller deployment cap from the expected
lifetime input budget, not treat 200,000 as a target.

An unaffiliated address cannot buy anchor-count growth at any gas price: `anchor()` fails at the role
check before a fold or counter write. It can self-register many address nodes (the measured call is
about 48,900 execution gas), but those records never enter the proof input or fee-band count.

## Exhaustion and recovery

The cap is permanent for one chained-hash generation. At 80%, or immediately after unexpected role
use:

1. Revoke the suspect `ANCHORER_ROLE`; preserve role and head-event logs.
2. Freeze and prove the last intended checkpoint. Retain its canonical score blob on independent
   targets and record its root, CID, checkpoint block, params hash, and old contract addresses.
3. Deploy a new accumulator/resolver, bounded `AnchorRegistry`, verifier, and `MerkleSnapshot` with a
   reviewed capacity. Bind both lanes before checkpoint 0; re-register identities and re-anchor only
   current heads.
4. Have the directory operator call `InstanceRegistry.update` for the same instance id. The prior
   `InstanceRegistered`/`InstanceUpdated` event sequence is the on-chain generation link; keep the
   old contracts queryable.
5. Have a constitutional holder of the old, vault-bound snapshot call `ProvingVault.migrate`. This
   is the custody authorization; a directory rewrite alone cannot move the tank.
6. Trigger/prove checkpoint 0 of the replacement and verify indexer, operator, and frontend discovery
   before restoring relayer grants.

Both `setAccumulator` and `setAnchorRegistry` are no-ops only for their current address after
checkpoint 0; semantic rotation is locked. This composes with issue #14's dense checkpoint-id and
monotonic-history invariants instead of attempting to splice a new generation into an old history.

## Regression evidence

- `AnchorRegistryTest`: unauthorized and 32-node Sybil ingress, admitted relay, non-address replay,
  exact capacity boundary, live lane-1 capacity consumption, constructor bounds, and reciprocal
  one-shot binding.
- `MerkleSnapshotTest`: post-checkpoint anchor-registry rotation is rejected; same-address no-op is
  safe.
- `ProvingVaultTest` and `operator-core/tests/decide.rs`: both lanes feed the same 200,000 global
  price/refusal boundary.
