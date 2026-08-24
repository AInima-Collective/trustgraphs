# Governance and network authority

The standard vouching wizard always creates a DAO Safe and records it as the network's **admin**:
the onchain authority allowed to change protected rules. The creator's wallet is not the direct
admin of that network.

The weighted-prior and composition workspaces currently make governance an explicit creation-time
choice, and the option is off by default. A governed creation uses the same DAO Safe model; an
ungoverned creation records the connected wallet as the program controller's admin. The authority
shown by the application is therefore part of the network's trust model, not a universal property
of every Trustgraphs instance.

## What "admin" means

Admin is a contract role, not a dashboard superuser. In a governed network, the DAO Safe holds the
network's highest-level permissions, owns the program controller, and owns any shared fund.
Changes are executed from the Safe only after they pass through the network's governance module.

The creator's wallet is recorded as the Safe's initial owner and delayed recovery proposer, but a
sealed execution guard prevents it from sending ordinary owner-approved transactions. Recovery is
a slow, visible fallback: a recovery action must wait through a public delay, and the DAO can
cancel it or replace the recovery proposer before execution.

## How a change is approved

A member with a score in a governed network can create a proposal containing the exact actions the
DAO would execute.
Voting power comes from the accepted score snapshot recorded when the proposal is created, so a
later score update cannot change that proposal's electorate or weights.

Each proposal has a voting delay, a voting period, and a quorum requirement. If it receives enough
participation and more voting power supports it than opposes it, it passes. A further execution
delay leaves time to inspect the result before the governance module can execute the approved
actions from the DAO Safe.

The Governance tab shows proposals, votes, their current state, and the actions they will execute.

## What the DAO can change

The DAO can approve changes to:

- scoring parameters, including trusted seeds, damping, weight bounds, and convergence settings;
- the network's scoring cadence and other protected settings;
- optional modules and shared-fund policy; and
- the scoring implementation itself by adopting a verifier for a new program version.

Parameter changes are published as new versions and take effect from a future checkpoint. Changing
the scoring program is a larger upgrade: a new implementation has a new verification key and
should be reviewed as a change to the algorithm, not as routine tuning. The verifier is not pinned
when a checkpoint is triggered, so a rotation also changes what can prove an already-triggered,
still-unproved checkpoint.

Vouching and revoking a vouch do not require a governance proposal. They are ordinary member
actions in standard and weighted vouch networks. Their effect appears in the next score update and
can change members' voting power in later proposals.

## Past scores do not change

Every accepted epoch remains tied to the inputs and parameters used to prove it. Factory
deployments with provenance enabled also record the accepted verifier, its code hash, and program
key. Governance updates do not rewrite that accepted history.

## Wallet-owned weighted and composition instances

Without **Create with governance**, a weighted-prior or composition instance is controlled by the
wallet recorded as its controller admin. Program-specific proposal and activation delays still
apply, but there is no member vote in front of the admin action and the network does not show DAO
governance as its authority.

Governance is structural at creation: the current interface does not convert a wallet-owned
instance into a governed one later. Applications should display the active authority so users can
distinguish these deployments from DAO-governed networks.

For the relationship between checkpoints, proofs, and parameter versions, see
[Epochs and proofs](../concepts/epochs-and-proofs.md).
