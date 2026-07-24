# Envelope-1 conformance fixtures (the M3 conformance set)

Vectors consumed by `packages/envelopes/tests/atproto_conformance.rs`.

## `interop/` — vendored upstream test vectors

Copied verbatim from **`github.com/bluesky-social/atproto-interop-tests`**
@ `056e5741bb330757205d6b16db5266fffcae937b`:

| file | pins | our code |
|------|------|----------|
| `key_heights.json` | `HeightForKey` | `mst::key_layer` |
| `common_prefix.json` | `CountPrefixLen` | `mst::lcp` |
| `signature-fixtures.json` | ES256 / ES256K, low-S required, DER rejected | `commit::{parse_multikey, verify_commit_sig}` |
| `commit-proof-fixtures.json` | canonical MST root CIDs per key-set | used to build `car/` (below) |

(`data-model-*.json`, `lexicon/*`, `firehose` frame vectors from the same repo are NOT
consumed — they target a general dag-cbor/lexicon validator that envelope-1 does not
implement; envelope-1 decodes only commit + MST-node shapes.)

## `car/` — canonical MST CARs (generated)

Built with **`github.com/bluesky-social/indigo`** `atproto/repo/mst`
@ `dfe5578fd537e71dd1ed884dd09b876dd768dfd5` (Go 1.26).

The generator (`scratchpad/mstgen`, not committed) inserts each fixture's `keys` into an
empty tree (all leaves sharing the fixture `leafValue` CID), and — importantly — asserts the
resulting **root CID equals `rootBeforeCommit`** from `commit-proof-fixtures.json` for all six
fixtures, and that indigo's own `Tree.Verify()` (`verifyStructure`) accepts each tree. Only
then are the MST node blocks written to a CARv1 with real dag-cbor (0x71) CIDs.

| file | commit-proof fixture | shape |
|------|----------------------|-------|
| `two_deep_split.car` | "two deep split" | h1 root + 3 leaves; 6 keys across sibling subtrees |
| `neighbor_two_layers_down.car` | "add on edge with neighbor two layers down" | h2 root with two **h1 pass-through** nodes bridging to h0 leaves |

`neighbor_two_layers_down.car` is the canonical witness that atproto bridges layer gaps with
keyless `{l, e:[]}` pass-through nodes (child height is always exactly parent−1), which is the
rule the layer-skip adversarial test enforces.

Value CIDs in these CARs are dangling (records omitted) — the structural Walker collects
`(key, value-CID)` pairs and never dereferences the value, so `Car::parse` content-addresses
only the node blocks.

## Crafted adversarial vectors

Not stored here — the ATTACK bytes are constructed in-test (hand-built MST nodes and synthetic
PLC+commit CARs signed with self-generated k256/p256 keys). See the test file.
