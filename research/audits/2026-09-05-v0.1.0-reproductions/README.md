# v0.1.0 review reproductions

These tests support the [readiness review](../2026-09-05-v0.1.0-review.md) at commit `a45687bfdf0cc5c3190aea9048b9ec79b24c3150`. They assert the problematic current behavior and pass before fixes. They are isolated from the default production test suite so they do not enshrine those behaviors as desired regressions.

Run from the repository root. Install the repository's normal Rust and Solidity dependencies first. No production source changes are required.

```sh
cargo test --locked \
  --manifest-path research/audits/2026-09-05-v0.1.0-reproductions/rust/Cargo.toml \
  --target-dir target -- --nocapture
```

This executes eight native tests against the repository's canonical path dependencies and signed Nostr fixtures. It does not generate an SP1 proof. The detached Cargo workspace and committed lockfile keep reproduction dependencies explicit.

```sh
FOUNDRY_TEST=research/audits/2026-09-05-v0.1.0-reproductions/solidity \
FOUNDRY_OUT=/tmp/trustgraphs-v010-review-out \
FOUNDRY_CACHE_PATH=/tmp/trustgraphs-v010-review-cache \
forge test --match-test '^test_(Review_|ChangedParams|BuildingHierarchy|Expiring)' -vv
```

This selects six new EVM checks. The governance tests reuse existing test fixtures; the matcher excludes their inherited tests. Output/cache stay in `/tmp`. One test creates a **local Sepolia fork** using the public RPC named in `ReleaseGovernanceReview.t.sol`; it makes read-only network requests and sends no public transactions. To run only the five offline checks, add `--no-match-test CanonicalProxySquat`.

| File | Behavior demonstrated |
| --- | --- |
| `rust/tests/rank.rs` | Zero-edge reachability and decay, complete native zero-vouch computation, dust remainder, small-pool rank inversion |
| `rust/tests/nostr.rs` | Seed absence becomes unseeded scoring; available witness omission changes the root without changing the input commitments |
| `rust/tests/signer.rs` | Insufficient-activity no-op followed by initialized singleton cannot bootstrap when more members become active |
| `solidity/ReleaseReadinessPoC.t.sol` | Quiet-graph parameter rotation is blocked; public hierarchy consent can exceed 16 ancestors |
| `solidity/ContributionExpiryPoC.t.sol` | Actual EAS accepts an expiring valuation into the permanent contribution fold |
| `solidity/ReleaseGovernanceReview.t.sol` | Contract consumes no-op initialization; a vote supersedes a prepared activity checkpoint; canonical Safe predeployment exhausts all 16 candidates |

The contract-transition tests use a mock verifier where the behavior is independent of cryptographic verification. The contribution test deploys actual EAS contracts, and the Safe test uses the configured canonical factory/singleton on a local fork. Each finding still requires a corrected end-to-end guest/contract regression during remediation.
