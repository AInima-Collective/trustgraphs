# How the rules change

A score is only as trustworthy as the process that controls its rules. Every trustgraphs network
therefore makes its authority and active parameters visible onchain.

## Network authority

The network creator chooses an admin when the network is created. That authority may be an
individual account, but a community can use a Safe so that protected actions require several
signers. Applications should inspect the configured authority instead of assuming that every
network has the same governance model.

The authority controls protected settings such as scoring parameters, proving policy, and optional
modules. Members do not need governance approval to perform ordinary actions such as vouching or
revoking a vouch.

## Parameter updates

Governed networks route parameter changes through a controller. A proposal records the complete
replacement settings and the earliest time they can become active. Until activation, the current
parameters continue to define proofs and scores.

This separation gives members and integrators time to inspect a change before it affects a new
checkpoint. The network detail page shows active and pending settings where the selected program
supports them.

Some inputs have their own update workflow. For example, replacing a
[weighted prior](../build/weighted-prior.md) is a governed settings change; adding a vouch is not.

## Program versions

The proving program and its verification key define the scoring rules. Replacing that program is
not ordinary parameter tuning. A new implementation has a new verification key and should be
treated as a version change or migration.

Earlier score roots remain tied to the program and parameters that produced them. A later update
does not rewrite an accepted epoch.

## What consumers should check

Before relying on a network, check:

- who holds its current authority;
- whether changes have a review delay;
- which parameters and program version are active; and
- whether optional governance or distribution modules are installed.

For the relationship between checkpoints, proofs, and parameter versions, see
[Epochs and proofs](../concepts/epochs-and-proofs.md).
