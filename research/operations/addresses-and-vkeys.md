# Addresses and vkeys

> Internal human-readable index of the current public release.

Ethereum Sepolia (chain 11155111) is the only supported public target. The canonical,
machine-readable record is [`deployments/sepolia.json`](../../deployments/sepolia.json); it pins
the deployment commit, blocks, transaction hashes, external dependencies, project contracts,
guest ELF digests, and verification keys. Release consumers validate that manifest and reject a
`planned` or incomplete record. It never contains an RPC URL, private key, database URL, or
service credential.

The active Sepolia generation (release `v0.1.1`, contracts) starts at block
11,670,854 and records release commit `6d3e272eef46ee9e06ab7caedb03fa733594c4ce`. The
operator image comes from release `v0.1.3` (same guests and vkeys; the operator changes since
v0.1.1 are the Pinata publication request and the chain-bound manifest loader). The previous generation's manifest is archived as
[`deployments/generations/v0.1.1/previous-sepolia.json`](../../deployments/generations/v0.1.1/previous-sepolia.json);
its addresses remain historical evidence and were not migrated.

The `instances` list records one showcase network, created through the browser wizard:

| Field                 | Value                                                                |
| --------------------- | -------------------------------------------------------------------- |
| Name                  | Ethereum Extitutional                                                |
| Instance id           | `0xe4470bdbbd69691686ecd6dec72fdf5c8caea136bf18f0a0214b6cf93c491ee3` |
| Vouch schema UID      | `0x89a1cffc5596e57c49583f0e257f41f4859a5c23af6e1c8d2c0c9f8e80c6139d` |
| MerkleSnapshot        | `0x6CbB8Fe3D33F7483Ec1c0Bb8567a39aCd18aF641`                         |
| EASIndexerResolver    | `0xf3CE152b68c8605e66A1149E8C811a9f7dFDD14d`                         |
| MerkleFundDistributor | `0x3321C56eefE022d5970ce7ff308af064b39CD2a7`                         |
| ParamsController      | `0xAdC95F50923aD857274611e06013160C6BDc2EFe`                         |

## Deployed addresses

### External dependencies

| Contract            | Address                                      |
| ------------------- | -------------------------------------------- |
| EAS                 | `0xC2679fBD37d54388Ce493F1DB75320D236e1815e` |
| EAS Schema Registry | `0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0` |
| SP1 Groth16 gateway | `0x397A5f7f3dBd538f23DE225B51f532c34448dA9B` |
| Chainlink ETH/USD   | `0x694AA1769357215DE4FAC081bf1f309aDC325306` |
| Circle test USDC    | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |

### Trustgraphs contracts

| Manifest entry                     | Address                                      |      Block |
| ---------------------------------- | -------------------------------------------- | ---------: |
| Schema registrar                   | `0x70d897D936370735008d40250d4cd9bDe6D62B4a` | 11,670,854 |
| Root verifier                      | `0xBf553f5737dbfE9bB5ea2E881E3329638f6A16A3` | 11,670,855 |
| Instance registry                  | `0x731F64E9A03282CA36Ed3d679a7662468B3c37c7` | 11,670,856 |
| Proving vault                      | `0x4Bb3E2F62aE3457B18030C0f748f42B0BB169f5E` | 11,670,864 |
| Trustgraphs factory                | `0x7E913FcA17dEdbE1f7610b51464AC3524970e813` | 11,670,870 |
| Imported EAS factory               | `0x73BD357729F4B846245DFAe7d2B88f08bCfF7322` | 11,670,877 |
| Signer verifier                    | `0x5Bbb202e81AFC6FfbB64F97aFeFa30d092383F6D` | 11,670,878 |
| Signer-sync module deployer        | `0x071DC91731A184bF0F58d5f91998573E82061b70` | 11,670,881 |
| Parent-authority module deployer   | `0xf1eEE62011718bf6938657aCf52289D0AE81f938` | 11,670,882 |
| Subnetwork registry                | `0x8a424C9A34AeB0D63ade308b660EDDF1FfC89B99` | 11,670,886 |
| Governed trustgraphs factory       | `0x69F0966Ef4D5d604E049Cc5A0237e4d1Ce002a57` | 11,670,885 |
| Governed imported EAS factory      | `0x4F6FFD8fBeB666Ba7cF1405d04f1238087402168` | 11,670,887 |
| Weighted verifier                  | `0xd5Da5C835C8d47a8A2cF9fFF3Db3e91236283853` | 11,670,888 |
| Weighted factory                   | `0x35C560fAE4a65d6F579Ba2348ACf723eab56A926` | 11,670,892 |
| Governed weighted factory          | `0x9b3cF205Bb29A4203ccb729f9CF3Fb1fEF7467E4` | 11,670,893 |
| Composition verifier               | `0x7944035945F8CE03f2Da71b9030973E5f8e1327d` | 11,670,895 |
| Trust-compose factory              | `0x66dF2Da93A13a4208b7015e67e27101a1e1Ba617` | 11,670,902 |
| Governed trust-compose factory     | `0xCF1B2d0234d526dfC1c68eEC9E36835FF02d7e12` | 11,670,903 |
| Contributions verifier             | `0xD56559ba91c08d165d1431e95D02E58Edf12530F` | 11,670,905 |
| Contributions factory              | `0x5e55DFD86df16cbB365b9978c76422b1F776Ca05` | 11,670,907 |
| Canonical Safe 1.3.0 singleton     | `0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552` |   external |
| Canonical Safe 1.3.0 proxy factory | `0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2` |   external |

## Program vkeys

A vkey identifies one exact SP1 guest binary. The on-chain verifier holds it as an immutable:
a proof from any other binary does not verify.

| Program              | Release vkey                                                         | Sepolia deployment                       |
| -------------------- | -------------------------------------------------------------------- | ---------------------------------------- |
| trust-graph          | `0x00bbf3b3cc5efe71ced29517bd09edac2720bcc795b7094a314db17c224dcea3` | verifier and factory live                |
| trust-graph-weighted | `0x0095b1a77a841e434307acdc8cd2340c3a82beda37cde4498170db3cdcc6eb80` | verifier and factory live                |
| trust-compose        | `0x00c6868afdf506311dcb1393a74f3c033ad0620ec25602b65d079227c88d9dfc` | verifier and factory live                |
| signer-sync          | `0x00f8ad1fd05ff8c894a1e8906b3e1a1f9fba968d14ef8a121d3107d3c57df7fb` | verifier and governed creation path live |
| contributions        | `0x0098fb1266d6ca97c12c529c29ef59b45dae9bede0cbe0990a2fbb1b4394d798` | verifier and factory live                |
| hypercerts           | `0x0072790ce927dab3afab201f8517b7b0ac36764c825825f6a23d9ed3c080c8d2` | release identity only                    |
| nostr-workspace      | `0x00a8e5183dbdab1ff521c068ff2d2d8ed840f5beef4f516964d345a16bc302af` | release identity only                    |

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
