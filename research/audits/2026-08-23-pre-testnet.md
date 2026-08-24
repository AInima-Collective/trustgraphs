# Pre-testnet security audit, 2026-08-23

Scope: `contracts/src` (75 files, 11,865 LOC excluding interfaces) at `main` `9a34786`,
plus the Rust guest/host/operator crates and the deploy scripts where a contract finding
depended on them. Full codebase, not a diff.

Method: the four methodologies aggregated in
[daoism-systems/solidity-audit-skills](https://github.com/daoism-systems/solidity-audit-skills)
(pashov adversarial, omega structural, quillshield cataloged, plamen language-native),
plus a fifth ZK-soundness orchestrator added because the library is Solidity-centric and
the guest/verifier binding is this protocol's highest-consequence seam. Roughly 60 leaf
agents, then a six-agent adjudication tier whose instruction was to *refute* rather than
confirm.

Baseline at audit start: `forge build` clean (2 `unsafe-typecast` warnings),
`forge test` 738 passed / 0 failed across 54 suites.

## Verdict for the testnet decision

**The trust-graph path can go to a public testnet once the four HIGH items below are
closed. The trust-compose path should not go with it.**

That split is not a hedge, it is the audit's main structural result. Compose instances
have a constant `leafCount` (the policy source count), no anchor registry, and an `acc()`
that moves every block because `block.number` is folded into the manifest header. Those
three facts together defeat two separate guards that hold correctly everywhere else. The
verifier actively tried to generalise the worst of it to trust-graph and could not:
`AttestationAccumulator._fold` moves `acc` and `leafCount` together, which closes it.

Separately, and independently of any finding here: **the Sepolia deploy path does not
exist in code yet.** `contracts/deploy/env.ts` knows only `dev` (31337) and `prod`
(Optimism 10). There is no chain-11155111 target, no `deployments/` manifest, and
`grep -rn 11155111 contracts/` returns nothing. The repo's own
`research/operations/sepolia.md` says this plainly ("not ready to deploy to Sepolia by changing
environment variables alone") and lists about fifteen required changes, none implemented.
The SP1 6.3.1 versus supported-gateway compatibility gate that document calls blocking is
also still open. Those are prerequisites to deploying at all, not audit findings.

## Findings

Severity reflects the adjudicated verdict, not the original agent claim. Every item below
survived a refutation pass; the ones that did not are listed further down, because what
was tested and did not hold is part of the deliverable.

### HIGH

**H-1. The proof-input ceiling everything is priced against is wrong by 58x, and the
monitoring that was supposed to cover it cannot fire.**
`InputCapacity.MAX_TOTAL_INPUTS` is 200,000 and `ProvingVault`'s comment claims the
operator derives its cycle limit from that constant. Running the real cost model shows the
operator refuses at about **3,467 inputs**: at 200,000 the estimate is 487.6B cycles
against an 8B limit. Neither `CapabilityProfile::default()` nor `cycle_limit` is
configurable. The 80%-of-200,000 alert added after the last audit therefore fires at
160,000, which is 46x past the point where proving has already stopped.
Measured attacker cost to reach the real ceiling: 78,191 gas per leaf, 271M gas total,
about 9 blocks and 0.0027 ETH at testnet prices. Lane 2 is roughly 3,600x cheaper per unit
and the reference relay is fail-open by default (`allowedNodeIds` empty means disabled)
and pays the gas itself.
The prior audit logged this as H-4 and accepted it with monitoring. That decision rested
on the 200,000 figure and on an alert that cannot reach the operator in time. It should be
re-taken.
*Fix:* derive the cap from the operator's actual cycle budget, make the budget
configurable, and move the alert threshold below the real cliff.

**H-2. `EASIndexerResolver` fails open before `bindSchema`, so an instance can be made
permanently unprovable for 24,034 gas, with no front-run required.**
`_requireBoundSchema` permits everything while `boundSchema == 0`. An attacker registers
their own schema against the freshly deployed resolver and attests; the foreign edge is
folded into `acc`. The honest `bindSchema` then *succeeds*, so the deployment reports
nothing wrong, and the poisoned leaf is permanent. The instance can never produce a valid
root: `input-exporter` filters `Attested` logs on `topic3 == schema_uid`, so the leaf is
never a candidate and `reconstruct` hard-fails.
`TrustgraphsFactory` and `WeightedTrustgraphsFactory` bind inside the same external call
and are immune. `DeployNetwork.s.sol` and `DeployEasResolver.s.sol` do not, and
`deploy-contracts.ts` hardcodes `--slow`, so the gap is a guaranteed several-block window
rather than a race. `DeployNetwork` is on the production list.
Nothing is stranded (this only hits a resolver with zero checkpoints, so recovery is a
redeploy), but it is indefinitely repeatable at roughly 250:1 cost asymmetry.
*Fix:* the same repo already ships both halves in `ContributionResolver`: an immutable
schema-admin gate, and reverting all attestations until the allowlist is set.

**H-3. The distributor's payout denominator is not covered by the funder's own guard, and
the distributor owner is an EOA in every factory path.**
`_distribute` checks `merkleState.root` against the funder's `expectedRoot`, but copies
`totalValue` into `totalMerkleValue` unchecked, and `claim` divides by it. A snapshot that
mirrors the honest root while shrinking `totalValue` passes the funder's guard, passes all
three fee guards from the last audit, and hands a single leaf 100% of a third party's
round.
Reachability is the part that matters: the previous audit's "roles renounced to timelocks"
holds for `MerkleSnapshot` and **not** for the distributor. `TrustgraphsFactory:458`
deploys it with `owner = admin`, documented as "0 means msg.sender", a creator EOA. Same
at the Weighted, Compose and Contributions factories and both `attachDistributor` paths.
Governed instances get the DAO Safe, still un-timelocked. `DeployNetwork.s.sol:173` leaves
the deployer EOA.
*Fix:* pin `totalMerkleValue` in the funder-guarded overload alongside the root; add a
per-round spend cap in `claim` (see M-8).
*Resolution (2026-08-23):* both halves are closed. The payout guards and spend cap
landed, and all four base factories now require an initialized Safe-compatible
owner whenever they create or attach a distributor. Contributions requires the
Safe unconditionally, governed wrappers supply their instance Safe, and
`DeployNetwork` takes the Safe as an explicit input instead of retaining the
deployer EOA.

**H-4. Any mempool watcher can permanently block governed instance creation for about 1.6%
of the victim's cost.**
`_createBootstrapSafe` derives the Safe CREATE2 nonce entirely from mempool-visible
calldata (`keccak256(chainid, creator, name, salt)`) with a constant initializer, and there
is no adopt branch and no fallback nonce, so a pre-deployed address hits
`require(proxy != address(0), "Create2 call failed")`. Because an occupied CREATE2 consumes
the whole child frame, the victim burns their gas limit: measured at **215,129 gas for the
squatter against 13,097,357 destroyed**, a 60.9:1 asymmetry. All three governed factories
share the code.
Capture is impossible (the same address requires the same initializer), and salts are
fresh CSPRNG per session, so this needs a front-run rather than pre-computation. But every
retry republishes the tuple one block before use, and the only real defence is a private
relay, which the contracts and app neither provide nor document.
*Fix:* precompute the address; if occupied, adopt it when it is a Safe on the expected
singleton with owners exactly `[address(this)]`, threshold 1, no guard or modules;
otherwise bump a bounded internal counter. A `try/catch` retry does not work, the gas is
already gone.

**H-5. `ContributionsParamsController.updateParams` skips the computational-safety envelope
every sibling controller applies, and the guest then proves a wrong answer happily.**
The controller validates only the three schema UIDs. `ContributionsParamsValidator.validateFinal`
exists and has **zero production call sites**. The halting case is recoverable (the owner
can roll back), but the same hole admits tuples the guest proves *and gets wrong*:
`evaluatorCarveoutBps = 10_001` wraps `s - beta_fp` in `alloy` U256 (confirmed in debug and
release) and flips the evaluator carve-out from the whole pool to three wei, with a valid
proof and a real payout. The TypeScript port does the same subtraction in `bigint` and goes
negative, so guest, host and display disagree on one `paramsHash`.
*Fix:* call the existing validator on the rotation path. One line. Fixing the guest's
wrapping subtraction as well would rotate the vkey, which is free now and a migration later.

**H-6. `ProvingVault.claim` prices a checkpoint with a different checkpoint's root.
Compose instances only.**
`claim` passes `snapshot.getLatestState().root` into a statement key whose counts come from
`checkpointId`: this checkpoint's size, another checkpoint's root. The comment one line
above states the correct rule. On compose, where the statement reduces to a pure function
of the output root, two things follow. `submitAndClaim` can revert `StatementAlreadyPaid`
and **roll back an already-verified root**, which is the only revert in `_settle` when every
other refusal skips instead. And `claim(oldCheckpoint)` marks the *newest* checkpoint's
statement, permanently destroying an earned bounty; a stranger can do it and gains nothing.
The "same statement paid twice" claim was **rejected**: the two checkpoints carry different
`acc`, so different journal digests and two distinct SP1 proofs. No theft from funders.
*Fix:* key the statement on the checkpoint's own `acc`, and have `claim` pass the
checkpoint's own root via `getAcceptedCheckpoint`. Plus `_skip` instead of revert, so a
payment refusal can never discard a verified root.

### MEDIUM

**M-1. `AnchorRegistry`'s head co-signature under-binds, and the previous fix made one case
worse.** The payload is `keccak256(HEAD_DOMAIN_TAG, head, count)`: no `envelopeKind`, no
`dataCommitment`, no registry address, no chain id. So one signature replays into a second
instance and across a chain-id change, and a victim's blind 32-byte `personal_sign` is a
valid head authorization. Soundness is unaffected because the guest re-verifies, but
availability is not: adding count-monotonicity (the H-5 fix) without a domain or range
check means a bogus head at a higher count outranks every honest head permanently, and
`count = type(uint64).max` is terminal with no admin reset, no de-registration and no
re-`register()`. The sibling `EasOffchainAnchorRegistry` gets this right with a full EIP-712
struct bound to `verifyingContract`; the two near-twins disagree.
**Correction (2026-08-23, dependency pass):** fixing this is not a local Solidity change. The
guest verifies the byte-identical preimage at `crates/envelopes/src/eas_offchain.rs:117-122`,
reached from both `main.rs` and `signer.rs`, so binding the domain rotates seven programs and
is the largest vkey batch in the remediation. The anchor *leaf* needs no change:
`zk-core/src/anchor.rs:17-33` already binds `envelopeKind` and `dataCommitment`. Split the
Solidity-only half (count range, admin reset) from the signature half.

**M-2. Governed factories take the signer-sync verifier from calldata.** The only
authenticity test is that the caller-supplied `verifier.programVKey()` equals the
caller-supplied `programVKey`, which a self-consistent pair satisfies trivially. Any
stranger can then seat themselves as sole Safe owner with `hex"00"` as the proof.
The filed impact ("seizes the Safe") is **refuted**: `SafeExecutionGuard` seals in the
creation transaction, so no owner signature executes, and a seized owner set cannot move 10
ETH or call `setGuard(0)`. But the guard is removable through the creator's
`DelayedRecoveryModule` after 14 days, at which point the drain succeeds, and nothing warns
whoever authorises the removal. The indexer stores `verifier` and never compares it to a
canonical address, so the "score-selected signers" claim is indexed as genuine.
*Fix:* immutable verifier and vkey on the three wrappers, as `TrustComposeFactory` already
does one file away.

**M-3. `CompositionSourceAdapterFactory.create` takes the registry as an argument and never
checks it.** Every provenance pin (snapshot, verifier, both codehashes, `programVKey`,
`paramsAuthority`, `programId`) is read from whatever registry the caller passes, and the
accumulator's only gate is `isAdapter[...]`, which the factory sets unconditionally. The
contract's own comment claims an ABI-compatible lookalike is rejected; it is not. Proven
end-to-end against the real `InstanceRegistry` and a real `TrustComposeFactory.createInstance`.
One shared adapter factory serves the platform, so the pollution is global. Capped at medium
because `installPolicy` is controller-gated and the indexer does not consume the adapter
factory yet.

**M-4. `SignerSyncZkModule.setAccumulator` has no rotation lock.** `MerkleSnapshot` refuses
rotation once a checkpoint exists; the signer module does not, and never resets
`lastAppliedCheckpoint`, so the id space can be swapped underneath a live high-water mark,
silently skipping ids and mixing two checkpoint histories. This module controls Safe signers.

**M-5. `WeightedPriorParamsController` reuses cancelled version numbers.** `proposePrior`
derives the pending version from the activated one and `cancelPrior` deletes the commitment,
so one version number can be minted repeatedly with different contents.
`TrustComposeParamsController` enforces the opposite with a `latestVersion` high-water mark.
The existing 256-run invariant suite misses this because it asserts
`pending.version == controller.version() + 1`, which is the buggy derivation itself: the
correct fix would make that suite fail.

**M-6. `TrustComposeValidator` admits an output pool below the source count**, after which
the guest allocator gives required sources zero. The repo already knows the guest must
reject this (`zk/prover/examples/trust_compose_guest_rejections.rs:35`). A variant the
original finding missed: `sourceCount` is rotatable while `outputPool` is not, so a policy
rotation can brick a live instance.

**M-7. A passed proposal never expires.** `Passed` is terminal, permanent and
permissionlessly executable, verified end to end: pass a proposal, rotate the root until no
former voter holds power, roll 5M blocks, execute, Safe seized. It survives the "intended
governance power" objection because the execution delay added last time is documented as an
*exit window*, and an exit window with no closing edge cannot do that job. This duplicates
the prior audit's GOV-4 (Low, unfixed) and is re-raised, not newly discovered.
*Fix:* a snapshotted execution window and an `Expired` state.

**M-8. Pause across a deadline converts contributor entitlements into a funder refund**, and
`sweep` is also `whenNotPaused`, so nothing exits. No deadline extension exists.
Related, filed as blast radius rather than a second theft path: there is no per-round spend
cap in `claim`, so any bad root source costs the entire shared token balance rather than one
round, and the over-paid round becomes permanently unsweepable through checked-arithmetic
underflow.

### LOW

- **L-1.** `ProvingVault` asserts the price feed reports 8 decimals but never checks the
  stablecoin's; `_pay` and `_payableUsd` hardcode `1e6`. An 18-decimal token overstates
  `payableUsd` by 1e12, and a 2-decimal token *overpays* (a $10 fee moves 100,000 whole
  tokens). Production wires 6-decimal Circle USDC and the token is immutable, so this is
  deployer error only. `research/operations/sepolia.md` already lists the check as required and
  unimplemented.
- **L-2.** `GraphLineageRegistry`'s `MAX_REFERRAL_SUBJECTS` is documented as bounding the
  concurrently active referral set and implemented over the lifetime set:
  `_referralClaimKeys` is append-only and never pruned on revoke, expiry or rotation, so an
  issuer who has cycled 64 subjects can never endorse a 65th even with zero active spend.
- **L-3.** `expirationTime` is accepted by the resolver and never enforced. EAS does not
  enforce it either (verified against EAS 1.8.0). The frontend renders an "Expired" banner
  for a status the proven score ignores.
- **L-4.** `MerkleSnapshot.trigger`'s `NoNewInputs` guard is structurally unreachable on
  compose, because `_capture()` folds `block.number` into the manifest header so `acc()`
  always moves. Standalone harm is bounded (minting is rate-limited by `EPOCH_FLOOR >= 7200`
  and `bandOf` flat-bands compose), and the repetition is deliberate design. It matters as
  H-6's precondition.
- **L-5.** `src/tokens/TEST.sol` constructs as `ERC20("TEST","TEST")` but
  `ERC20Permit("MyToken")`. EIP-2612 fixes the domain name to the token name, so every
  wallet-produced permit signature is rejected.

### Informational

- `SP1JournalVerifier`'s constructor validates neither argument, and
  `TrustAccumulatorMirror.bindSnapshot` lacks the sibling check that
  `CompositionSourceAccumulator.bind` and `EmptyLaneAccumulator.bindSnapshot` both have.
  Neither is exploitable (both fail closed, both are deployer-only and atomic in production),
  but roughly 200 gas turns a silent mis-deployment into a revert.
- `MerkleGovModule`'s NatSpec justifies the delegatecall allow-list as "bypassing any Guard".
  Module execution never reaches a Safe guard at all, so the stated rationale is wrong even
  though the code is fine.

## Checked and found sound

- **Encoding parity across Rust, Solidity and TypeScript.** The four fields no golden vector
  currently covers (non-empty `domainSetHash`, a `paramsHash` with `minWeightFp` /
  `envelope0DomainSeparators` / `lane2MaxHeadAge` non-default, an anchor leaf with
  `envelopeKind != 0`, and a multi-entry `skippedDigest`) were checked against the Rust
  implementation and **agree**. The action is to add the vectors, not to fix an encoding.
  **Correction (2026-08-23):** only two of the four are genuinely unpinned. `envelopeKind != 0`
  and the multi-entry `skippedDigest` are already covered by `tests/golden/nostr-workspace.json`;
  they looked missing because nostr-workspace is absent from the `zk-parity` CI matrix.
- **Distributor conservation under an honest root.** `total_value` is the exact fold-sum of
  the same `assigned` vector the leaves are built from, and `submitProof` binds both into one
  journal digest, so `sum(leaves) == totalValue` is guaranteed by the proof. Floor division
  plus one claim per account per round makes conservation a theorem. Verified with a
  256-run fuzz.
- **EAS integration boundaries:** only EAS can reach the resolvers, cross-schema revocation
  is isolated, `AttestationAccumulator.bindSnapshot` is properly gated, and
  `ContributionResolver`'s schema allowlist is the correct pattern.
- **`EasOffchainAnchorRegistry` head authentication**, which is the reference implementation
  its sibling should copy.
- **The prior audit's merged fixes hold**: quorum snapshotting per proposal, hook isolation
  under a 500k stipend (honest hook cost measured at 37,111 gas), the execution delay,
  balance-delta funding accounting, and the 3-day fee-increase delay.
- **Verifier wiring fails closed.** A codeless gateway and a codeless ZK verifier both reject;
  solc emits the extcodesize guard. Only a hand-deployed always-succeed gateway accepts
  garbage, and the mock-gateway script is chain-id-gated to 31337.

## Claims raised and rejected

Reported because knowing what was tested and did not hold is part of the result.

- **Safe self-call bypasses the delegatecall allow-list.** Rejected. Reaching `enableModule`
  through a passed proposal is the documented design (`research/GOVERNED_SAFE_AUTHORITY.md`),
  the module's owner *is* the Safe so governance sets the allow-list anyway, and the PoC's
  "baseline denial" is vacuous: delegatecall preserves `msg.sender` as the module and fails
  Safe's `authorized` regardless.
- **A long proven CID starves the governance hook.** Rejected. The CID is derived in-guest
  (`"b"` + base32 of 36 bytes, exactly 59 characters in all five program crates) and bound
  into the verified journal. Both PoCs only worked because they used an accept-everything
  mock verifier and an empty proof.
- **Vote tally can exceed total voting power.** Rejected for honest roots: `total_value` is
  the fold of the leaf vector, and weighted-prior and composition enforce the sum identity
  explicitly. The PoC hand-built a stub with a 1000-point leaf and `totalValue = 0`.
- **Cross-distribution insolvency as an independent accounting bug.** Rejected and demoted:
  every "drain" PoC reaches its state through a dishonest snapshot, which is H-3, not a
  separate defect.
- **Double payment from the proving vault.** Rejected (see H-6).
- **A claim return-data bomb prices itself out of a block.** Rejected on its own terms:
  15.8M gas against a 30M limit.
- **Reverting fee recipient blocks every native round.** Rejected: factory paths set
  `feePercentage = 0`, so `_distribute` skips the transfer entirely.
- **`PayableEASIndexerResolver` batch value splitting.** Rejected: it has no accumulator, is
  deployed nowhere, and the PoC's own result is that its accounting is exact.
- **Lineage params desync.** Demoted to a lead, and re-pointed: the registry pins to
  InstanceRegistry facts as documented, but `MerkleSnapshot.setParamsHash` and
  `InstanceRegistry.updateParamsHash` are two writers with no reconciliation.

## General

From the readiness pass. Audit-readiness scored **72/100**: strong docs and genuinely
adversarial test names against zero static analysis and a deploy pipeline that does not
match its own runbook. Deploy-readiness alone scored 5/10.

- **`forge coverage` has never produced a number for this protocol.** `--ir-minimum` hits
  Yul stack-too-deep at `factory/TrustgraphsParamsController.sol:17`; plain hits it at
  `merkle/MerkleSnapshot.sol:473`.
- **25 of 54 in-scope contracts have no dedicated test file.** The ones that matter, all in
  the newest layer: `TrustComposeParamsController` (307 LOC), `CompositionSourceAccumulator`
  (288), `TrustComposeFactory` (263), `CompositionSourceAdapter` (232), `InstanceDeployers`
  (201), `ContributionsParamsValidator` (150), `TrustgraphsParamsValidator` (136),
  `AttestationAccumulator` (124), `TrustgraphsParamsController` (113), and the five params
  codecs. `GraphLineageRegistry` (584 LOC) has 7 test functions. `eip712/EIP712Verifier.sol`,
  `factory/NostrWorkspaceParamsAuthority.sol` and `limits/InputCapacity.sol` have zero
  references anywhere.
  This is where the HIGH findings landed. It is not a coincidence.
- **Test shape:** 738 tests, 12 fuzz, 1 invariant suite, 0 fork tests, no echidna, medusa,
  certora or halmos. The lone invariant suite targets 3 selectors on one handler.
  `MerkleSnapshot.t.sol` has zero fuzz tests.
- **`Common.s.sol:8-9` still defaults to the Anvil key** for all 29 deploy scripts, with no
  chain-id assert, while `research/operations/sepolia.md` lists removing exactly that as a launch gate.
- **CI has no static analysis at all.** `forge fmt --check` fails on 6 source files, all in
  post-audit code; clippy is commented out in `rust.yml`; `nostr-workspace` is missing from
  the `zk-parity` matrix.
- **Docs drift:** three documents tell three different chain stories (`production.md` uses
  Optimism envs, `sepolia.md` says Optimism is retiring, `addresses-and-vkeys.md` targets
  mainnet). `docs/learn/limits.md` never mentions the composition layer.
  `docs/README.md:57` links to `../paper/`, deleted in `7fcf5fd`, a live 404 in the in-app docs.
- `RoleSeparatedTimelockController`, which is production governance, lives inside
  `contracts/script/DeployTimelocks.s.sol`, outside `src` and outside every `src`-scoped tool.

## Coverage manifest and agent census

Methodologies run: pashov (13 attacker agents), omega (5 independent passes plus a
regression pass and a repo-hygiene sweep), quillshield (11 topic plugins), plamen (EVM pack
plus governance, cross-VM-serialization, determinism and integration injectables, niche
skills and 4 depth agents), and an added ZK-soundness orchestrator (6 leaf agents).
Deliberately skipped: the Solana, Sui, Aptos, Soroban, DAML and L1-client packs (wrong
platform), and the NFT, account-abstraction, lending, DEX and ERC-4626 injectables (no
trigger, no such surface).

Adjudication: 6 adversarial verifiers, one per cluster group, instructed to refute.

**Honest gap in this record.** The five methodology orchestrators completed their fan-out
and wrote their reports, but the process hosting them exited before those reports were
collected, and the scratchpad holding them was cleared. What survived is what the agents
had written into the repository: **41 proof-of-concept test files, 172 tests**. Those were
recompiled and run as the ground truth for this report (167 pass, 5 fail), and every
surviving claim was then adjudicated against production source. What was lost is the
orchestrators' prose: their LEAD lists and their CLEARED lists. So the "checked and found
sound" section above is narrower than the work that was actually done, and there are
probably leads that no longer have a record. The findings themselves are unaffected, because
findings were carried by the PoCs and the PoCs survived.

Of the 5 failing PoCs: 3 are harness artifacts whose underlying claim is proven by passing
siblings (one was caused by solc hoisting `block.number` across `vm.roll`, so the second
roll was a no-op), and 2 are genuine refutations, recorded above.

## Two operational notes

**The working tree changed under the audit.** `contracts/src/zodiac/SignerSyncZkModule.sol`,
`MerkleGovModule.sol`, the three governed factories, `InstanceDeployers.sol` and several
params files were modified between 01:16 and 01:31 while the audit was running, adding an
`ISignerActivitySource` seam and changing a constructor to 13 arguments. That is feature work
from another process, not from this audit; it has since landed as `8d0b67e`
("feat: harden scoring engine for production"), so `main` is one commit ahead of the
`9a34786` this audit was performed against. A verifier mid-pass reported the suite no longer
compiled because two unit tests still used the old arity; by the end of the audit the call
sites had been updated to match (13 arguments, including `activitySource`), so that refactor
now looks self-consistent. This was not re-verified by a full compile: `forge build` is
OOM-killed in this sandbox (solc SIGKILL on 107 files with `via_ir`), which is a memory
limit here and not a compile error. **Re-run `forge build && forge test` on a machine with
more memory before trusting any baseline in this report.**
Findings were re-derived against the current bytes where they touched changed files: H-4's
CREATE2 salt derivation is unchanged, and M-4 survives unchanged. Everything else cited was
verified against the pre-edit tree.

**The evidence is in the tree.** **Correction (2026-08-23):** it was untracked when this report was written and has since been committed (`90765d6`), so the five deliberately-failing tests now turn `forge test` red on `main` until dispositioned. Originally: `contracts/test/audit-poc/` holds 41 PoC files
plus 12 verifier tests, and `crates/hypercerts-core/tests/audit_poc_leaf_domain.rs` is one
more. Nothing is staged and nothing under `contracts/src` was modified by this audit. The
PoCs are worth keeping until the fixes land, since each one is an executable regression test
for a specific finding, but they are disposable and can be deleted wholesale.

## Suggested order of work before testnet

1. H-1, because it changes what the system can do at all, and because the number it corrects
   is load-bearing for a decision already taken.
2. H-2 and H-5, both one-line-ish fixes with existing correct patterns elsewhere in the repo.
3. H-3 and H-4, which need small design choices (pin the denominator; adopt-or-bump).
4. Hold trust-compose. H-6, M-3, M-6 and L-4 are all compose-path, and compose has the least
   test coverage in the repo.
5. Add the four golden vectors from the parity check, while they are free.
