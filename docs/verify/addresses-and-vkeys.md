# Addresses and vkeys

This page is the canonical registry of deployed contract addresses and program verification
keys (vkeys). Anything you verify against should trace back to a value published here, not to
a value someone told you in a chat.

**Today's truth: there is no production deployment.** No trustgraphs contract set exists on
any public chain yet. Ethereum mainnet is the deployment target, with Sepolia as the
rehearsal, per [`build/production.md`](../build/production.md). What is exercisable right now
is a local anvil deployment or a mainnet fork ([`build/quickstart.md`](../build/quickstart.md)).

## Deployed addresses

| Chain | Contract | Address |
|---|---|---|
| Ethereum mainnet | none yet | |
| Sepolia (rehearsal) | none yet | |

When an instance ships, this table gains one row per contract in its set (`MerkleSnapshot`,
`SP1JournalVerifier`, `EASIndexerResolver` or `AnchorRegistry`, governance modules), plus the
deploy transaction. Until then, treat any "official trustgraphs address" you encounter
elsewhere as false.

## Program vkeys

A vkey identifies one exact SP1 guest binary. The on-chain verifier holds it as an immutable:
a proof from any other binary does not verify.

| Program | Deployment vkey |
|---|---|
| trust-graph | none yet |
| trust-graph-weighted | none yet |
| trust-compose | none yet |
| signer-sync | none yet |
| hypercerts | none yet |
| contributions | none yet |

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
