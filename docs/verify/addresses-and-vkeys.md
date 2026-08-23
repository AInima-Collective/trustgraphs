# Addresses and vkeys

This page is the canonical registry of deployed contract addresses and program verification
keys (vkeys). Anything you verify against should trace back to a value published here, not to
a value someone told you in a chat.

**Pre-testnet truth: there is no public deployment.** The first planned public release is the core
`trust-graph` path on Ethereum Sepolia (chain 11155111), following the
[`Sepolia release plan`](../build/sepolia.md). Ethereum mainnet is a later production target.
`trust-compose` is intentionally not part of the first Sepolia testnet. What is exercisable right
now is a local Anvil deployment or a local mainnet-fork simulation
([`build/quickstart.md`](../build/quickstart.md)).

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
[`concepts/networks-and-programs.md`](../concepts/networks-and-programs.md), and they carry a
caveat worth taking seriously: they were derived on a development box, and the vkey depends on
the exact build of the SP1 `succinct` toolchain, not just on the source. A toolchain reinstall
has been observed to shift vkeys with zero source change. The measurements behind that caveat
are in [`research/VKEY_NOTES.md`](../../research/VKEY_NOTES.md).

Deployment-grade vkeys will therefore be derived on a pinned toolchain as part of the deploy
ceremony and published in the table above, alongside the source commit they were derived from.

## Re-derive a vkey yourself

```bash
# once per checkout: build the guest ELFs with the pinned SP1 toolchain (v6.3.1)
task zk:build

# print the vkey for any program listed in the program index
task zk:vkey PROGRAM=trust-graph
```

Two things to know when comparing values:

- Your value may legitimately differ from another machine's if your `succinct` toolchain
  build differs, even at the same source commit. The comparison that matters is against the
  deployed verifier, on the pinned toolchain, at the published commit.
- Once contracts exist, the deployed value is readable directly from the chain:
  `cast call $VERIFIER "programVKey()(bytes32)"`. Matching that against your own derivation,
  from source you can read, is the whole point: the vkey is what makes
  [reproducing an epoch](./reproduce-an-epoch.md) a check on the program itself, not just on
  its output.
