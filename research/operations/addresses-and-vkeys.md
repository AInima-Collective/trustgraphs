# Addresses and vkeys

> Internal human-readable index of the current public release.

Ethereum Sepolia (chain 11155111) is the only supported public target. The canonical,
machine-readable record is [`deployments/sepolia.json`](../../deployments/sepolia.json); it pins
the deployment commit, blocks, transaction hashes, external dependencies, project contracts,
guest ELF digests, and verification keys. Release consumers validate that manifest and reject a
`planned` or incomplete record. It never contains an RPC URL, private key, database URL, or
service credential.

The Sepolia deployment starts at block 11,565,413 and records release commit
`f64a4c7c9b5e552e2392894a2e0d6f6c40973549`. Its `instances` list is currently empty; factory
contracts are live, but no showcase instance is claimed here until its creation transaction is
added to the manifest.

## Deployed addresses

### External dependencies

| Contract | Address |
| --- | --- |
| EAS | `0xC2679fBD37d54388Ce493F1DB75320D236e1815e` |
| EAS Schema Registry | `0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0` |
| SP1 Groth16 gateway | `0x397A5f7f3dBd538f23DE225B51f532c34448dA9B` |
| Chainlink ETH/USD | `0x694AA1769357215DE4FAC081bf1f309aDC325306` |
| Circle test USDC | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |

### Trustgraphs contracts

| Manifest entry | Address | Block |
| --- | --- | ---: |
| Schema registrar | `0x4f74b6C19e84639421692df9abD5c587e0d20fb9` | 11,565,413 |
| Root verifier | `0xFF850b9c0198Fa9fF9e28e9DFEdB39b1cb7E0bd4` | 11,565,414 |
| Instance registry | `0x4369ad64D4E378BEc45eE1081394cCD8A0052904` | 11,565,416 |
| Proving vault | `0x940e4D678a1581560b5C59701aF283beD9F9BFFc` | 11,565,424 |
| Trustgraphs factory | `0xd14aF10B0546A247d68E01AE5ef3b73C6e116E35` | 11,565,430 |
| Signer verifier | `0xF99e2c06018f2Aa8078859854ecb1fC3C7368b63` | 11,565,969 |
| Signer-sync module deployer | `0x71CaAe36fF68b329422283bD14Eb88c1D90952c9` | 11,565,972 |
| Governed trustgraphs factory | `0xFd0ee86105bF67C5c74653b8268c74120C485b6b` | 11,565,975 |
| Weighted verifier | `0xf19507cCcfA09fE18A15Abc2aee595413A576ee2` | 11,567,209 |
| Weighted factory | `0x59a513e2a0b88CCA9f642BE1d67348A8bFF87133` | 11,567,214 |
| Governed weighted factory | `0x182CE62522DB88d20794eC2d32b9fF723c9e732D` | 11,567,216 |
| Composition verifier | `0xd6d94310025EFe103284D195F1E7D1F215E13707` | 11,567,217 |
| Trust-compose factory | `0x2f5Ef810326AdE3d2F5e48Ce7727BE1b8952c696` | 11,567,226 |
| Governed trust-compose factory | `0x5654ed69EC94bCB312d867dc9408F029038F0337` | 11,567,227 |
| Contributions verifier | `0x099Fb1c2C2d41A426b459f7f516CB070e7bC9e12` | 11,567,228 |
| Contributions factory | `0xa93F50d42b7491b4A01Be7449e8c9CCf1591933e` | 11,567,231 |
| Canonical Safe 1.3.0 singleton | `0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552` | external |
| Canonical Safe 1.3.0 proxy factory | `0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2` | external |

## Program vkeys

A vkey identifies one exact SP1 guest binary. The on-chain verifier holds it as an immutable:
a proof from any other binary does not verify.

| Program | Release vkey | Sepolia deployment |
| --- | --- | --- |
| trust-graph | `0x003c8e19b8e12c260e5450a068c61460180b5cf93f03dc1214187a9ad3bdde5e` | verifier and factory live |
| trust-graph-weighted | `0x0027625a41e9d165ab50ca4ff9afbc134385b99688a5fd69cdf03d5056f5abb2` | verifier and factory live |
| trust-compose | `0x00e2847cc257d916a6422283094e8764296045e5f9ed8805b7aaa9b3dd6f7aed` | verifier and factory live |
| signer-sync | `0x00d1b981df6bee1682be2b212151d2ac74c30108215d8e949a84a604ae4baadb` | verifier and governed creation path live |
| contributions | `0x0083cb62532a5c855c0c1b61a1eb7b7d5d6d924784342ea661c80baf79cfa243` | verifier and factory live |
| hypercerts | `0x009890d8fed8be4836e060c25ad267049efbe79ce929b0e63c1e086007008d40` | release identity only |
| nostr-workspace | `0x003a7984610aa854a8daa012d2d78846ba663781c8fe3aa74fed99be047b6566` | release identity only |

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
