# Addresses and vkeys

> Internal release record retained from the original public guide.

This page is the canonical registry of deployed contract addresses and program verification
keys (vkeys). Anything you verify against should trace back to a value published here, not to
a value someone told you in a chat.

**Pre-testnet truth: there is no public deployment.** The first planned public release is the core
`trust-graph` path on Ethereum Sepolia (chain 11155111), following the
[`Sepolia release plan`](./sepolia.md). Ethereum mainnet is a later production target.
`trust-compose` is intentionally not part of the first Sepolia testnet. What is exercisable right
now is a local Anvil deployment or a local mainnet-fork simulation
([`quickstart.md`](./quickstart.md)).

The tracked [`deployments/sepolia.json`](../../deployments/sepolia.json) is currently a sanitized
`planned` manifest: it fixes chain identity and canonical external dependencies but intentionally
contains null project addresses, receipt blocks, transaction hashes, ELF digest, and vkey. Release
consumers reject it until the deploy ceremony finalizes all required fields. It never contains an
RPC URL, private key, database URL, or service credential.

## Deployed addresses

| Chain                                  | Contract | Address |
| -------------------------------------- | -------- | ------- |
| Ethereum Sepolia (first public target) | none yet |         |
| Ethereum mainnet (later target)        | none yet |         |

When an instance ships, this table gains one row per contract in its set (`MerkleSnapshot`,
`SP1JournalVerifier`, `EASIndexerResolver` or `AnchorRegistry`, governance modules), plus the
deploy transaction. Until then, treat any "official trustgraphs address" you encounter
elsewhere as false.

## Program vkeys

A vkey identifies one exact SP1 guest binary. The on-chain verifier holds it as an immutable:
a proof from any other binary does not verify.

| Program              | Deployment vkey |
| -------------------- | --------------- |
| trust-graph          | none yet        |
| trust-graph-weighted | none yet        |
| trust-compose        | none yet        |
| signer-sync          | none yet        |
| hypercerts           | none yet        |
| contributions        | none yet        |

The first Sepolia manifest will publish only programs that pass that release's gate; it will not
gain a `trust-compose` address or vkey merely because compose is available in local development.

Dev-derived values for each program appear in
[`concepts/networks-and-programs.md`](../../docs/concepts/networks-and-programs.md).

A caveat used to belong here, and it is worth recording what it said and why it is gone. The vkey
depended on the exact build of the SP1 `succinct` toolchain rather than only on the source: a
toolchain reinstall was observed to shift vkeys with zero source change, and readers were told
their value might legitimately differ from another machine's. The measurements are in
[`research/VKEY_NOTES.md`](../../research/VKEY_NOTES.md). Succinct's own documentation says the
same thing about the build mode those values came from — "running `cargo prove build` may not
generate a reproducible ELF which is necessary for verifying that your binary corresponds to given
source code."

Every guest is now compiled inside the pinned SP1 builder image (`scripts/build-guests.sh`, and
`--docker` under it), so the ELF is a function of the source and the pinned image alone. Two
consequences follow, and the second is the one that mattered:

- **A mismatch now means something.** Before, "your vkey differs from the published one" and "the
  published one is not what it claims" were indistinguishable. They no longer are.
- **The claim is checked, not asserted.** `.github/workflows/guest-reproducibility.yml` builds
  every guest on two architectures, cold, and fails if the ELF digests differ. The release
  workflow runs it as a gate, so an image and a vkey table can only be published from a build two
  machines agreed on.

Deployment-grade vkeys are published in the table above alongside the source commit, and every
release attaches `guest-manifest.json` — each program's ELF sha256 and vkey against a public
commit, produced by a public workflow run rather than by anyone's laptop. That asset is the
reproducible-build artifact [`UPGRADE_GOVERNANCE.md`](../../research/UPGRADE_GOVERNANCE.md) §Lane C
asks for.

## Re-derive a vkey yourself

```bash
# once per checkout: build the guest ELFs inside the pinned SP1 builder image (needs Docker)
task zk:build

# every program's ELF sha256 and vkey, in the same shape as a release's guest-manifest.json
task zk:manifest

# or just one program's vkey
task zk:vkey PROGRAM=trust-graph
```

Two things to know when comparing values:

- **Your digests should match the release asset exactly.** If they do not, either the guests were
  built outside the pinned image — `build.rs` prints a warning naming the consequence when it
  falls back — or the published artifact does not correspond to the commit it names. Both are
  worth stopping over; neither is normal.
- Once contracts exist, the deployed value is readable directly from the chain:
  `cast call $VERIFIER "programVKey()(bytes32)"`. Matching that against your own derivation,
  from source you can read, is the whole point: the vkey is what makes
  [reproducing an epoch](./reproduce-an-epoch.md) a check on the program itself, not just on
  its output.
