# Create a network

The create flow deploys an independent trustgraphs network for your community. Each network has its
own inputs, scoring parameters, governance, proof history, and current score root.

## Choose a network type

Open [the create page](/create) and choose:

- **Standard trust graph** for equal starting influence and Ethereum vouches.
- **Weighted prior** when selected accounts need different starting influence.
- **Score composition** when the input is several existing, proven score sets.

These are separate programs. Creating one does not convert or overwrite an existing network.

## Prepare the network

Before signing, decide:

- the network name and public metadata;
- the account or Safe that will control protected settings;
- the founding accounts, or the complete weighted-prior manifest;
- scoring parameters and checkpoint cadence; and
- whether to attach governance or a fund distributor.

The app previews the addresses, weights, parameters, and ownership model that will be committed.
Review the authority carefully: it determines who can change protected settings after creation.

## Create it

Connect the admin wallet, complete the form, and simulate the transaction. The app will not ask for
a signature until the configuration passes its contract checks.

One successful creation transaction registers the network and deploys its required contract set.
The network then appears in the public catalog without a configuration pull request or app
deployment.

## After creation

A new trust graph still needs input and a proven checkpoint:

1. Members add vouches or the operator imports the intended starting data.
2. The network reaches its next checkpoint.
3. A prover computes the scores, publishes the score file, and submits the proof.
4. The accepted Merkle root makes the scores available to apps and contracts.

Creation and later administration are separate. Use the network's Settings page for governed
parameter or prior changes; use its member actions for ordinary vouches and revocations.

See [How scoring works](../learn/how-scoring-works.md) for the score model,
[Run locally](./quickstart.md) for a complete development deployment, and
[Integrate scores](./integrate-scores.md) for consuming the result.
