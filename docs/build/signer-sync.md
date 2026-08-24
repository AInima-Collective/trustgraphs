# Signer sync

Signer sync is an optional extension that keeps a Safe's owner set aligned with a network's proven
scores and recent activity. It does not compute the network's reputation scores and does not alter
the score root.

## What it does

The extension selects eligible accounts from an accepted score checkpoint, applies the configured
owner-count and threshold rules, and proves the proposed Safe owner set. A Zodiac module verifies
that proof before changing the Safe.

The proof is bound to the Safe's current owners and threshold. A proposal prepared for an older
owner set cannot be applied after the Safe has changed.

## Safety model

Score alone is not enough to remove owners. The configuration also requires recent activity and
witness approval for rotations. Minimum thresholds and owner limits are enforced when the module
is configured and again when a proof is applied.

Signer sync should be treated as governance automation: the Safe decides whether to install the
module and which rules it may enforce. Communities that do not want automated owner rotation can
use trustgraphs without it.

For the underlying score lifecycle, see [Epochs and proofs](../concepts/epochs-and-proofs.md).
