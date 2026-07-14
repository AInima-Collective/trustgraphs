# signer-sync — Architecture

The design lives in [`../../research/SIGNER_SYNC_ZK_PLAN.md`](../../research/SIGNER_SYNC_ZK_PLAN.md).

`signer-sync` is a second SP1 program that proves the deterministic top-N selection of Safe owners
from the same trust graph the [`trust-graph`](../trust-graph/ARCHITECTURE.md) root producer uses. It
reuses the shared `AttestationAccumulator` and `paramsHash`, but carries its own guest bin, journal,
verification key, and `SP1JournalVerifier` instance; its consumer is `SignerSyncZkModule`, which diffs
the proven owner set against a Zodiac Safe's live owner list on-chain via `submitSignerProof`.

To operate the program, see [`RUNBOOK.md`](./RUNBOOK.md).
