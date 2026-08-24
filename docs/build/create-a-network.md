# Create a network

The creation flows deploy independent Trustgraphs instances. Each network selects its initial
program verifier, input commitments, parameters, authority, and proof-history contracts.

## Choose the computation

Open [the create page](/create) and choose:

- **Standard trust graph** when members will create EAS vouches and the starting accounts should
  divide their initial share equally.
- **Weighted prior** when the scoring program should use a reviewed account-and-weight allocation
  as its persistent personalized prior.
- **Score composition** when the input is the accepted output of several existing networks.

These are separate programs and deployments. A weighted prior is not an update to a standard
network, and a composition does not merge or rewrite its source networks.

## Prepare the committed choices

The exact fields depend on the program. Before signing, expect to review:

- the network name and public metadata;
- the starting accounts or complete weighted-prior manifest;
- scoring parameters and checkpoint cadence;
- program-specific source or composition policy commitments; and
- optional features offered by that creation flow, such as a shared fund, strict offchain EAS
  lane, proving prepayment, or signer sync.

Authority differs by creation flow:

- The standard vouching wizard always uses the governed factory. It deploys a DAO Safe, records
  that Safe as the network admin, and offers no governance-off toggle.
- The weighted-prior and composition workspaces offer **Create with governance** when the governed
  factory is available. That option is off by default. Without it, the connected wallet owns the
  program's controller directly; with it, a newly deployed DAO Safe does.

For a governed creation, the connected wallet becomes the Safe's initial recorded owner and a
delayed recovery proposer, but a sealed guard prevents ordinary owner-signed execution. Members
control protected actions through delayed trust-weighted governance. A wallet-owned weighted or
composition instance has a different authority model and does not gain DAO governance later.

Review the creation summary carefully. Program parameters, source commitments, optional modules,
and authority determine what later proofs and governance actions can do.

## Create the instance

Connect the creator wallet, complete the relevant workspace, and simulate the transaction. The app
does not request a signature until its preflight checks pass.

A successful factory transaction deploys and registers the required contract set. The indexer can
then discover the instance from registry events; publishing a new network does not require editing
a static catalog or deploying the frontend again.

## Produce the first result

Creation fixes the computation but does not guarantee that a result has already been proven.
What happens next depends on the program:

- Members of a standard or weighted network create and revoke vouches. A weighted network also
  needs its exact active prior manifest to remain available to the prover.
- A composition captures eligible source checkpoints under its committed policy.
- An operator freezes an eligible checkpoint, reconstructs the program-specific witness, computes
  the output, publishes its canonical file, and submits the proof.
- Once accepted, the output root and Merkle proofs are available to applications.

Creation and later administration are separate workflows. Ordinary vouches never require a DAO
proposal. On a governed instance, protected parameter, verifier, composition-policy, or
weighted-prior changes pass through Governance and then their program-specific controller delay.
On a wallet-owned weighted or composition instance, the controller admin proposes those changes
directly. Input and parameter changes affect later checkpoints. A verifier rotation affects later
submissions, including already-triggered unproved checkpoints, but does not rewrite accepted
history.

See [Governance](../learn/governance.md) for the default authority model, [Run a
prover](./run-a-prover.md) for operating checkpoints, and [Integrate proven
outputs](./integrate-scores.md) for consuming address-based results.
