# Trust graph

The standard trust graph turns signed vouches between Ethereum accounts into a score for each
account. It is the default program for communities that want reputation to emerge from their
members' relationships.

## How it works

Members vouch for accounts they trust and can revoke those vouches later. Each vouch becomes a
directed edge in the graph. At a checkpoint, the prover reads the complete committed history,
applies revocations and the network's scoring parameters, and computes the next score set.

The proof commits to both the checkpoint inputs and the published score file. The network contract
accepts a new Merkle root only when that proof verifies, so applications can check individual
scores without trusting the operator that produced them.

## When to use it

Choose the trust graph when:

- members can identify one another by Ethereum address;
- a vouch is the main signal of trust;
- selected starting accounts should divide their reserved starting share equally; and
- applications need scores that can be verified against an onchain root.

Reachable non-starting accounts divide any unreserved starting share. Accounts outside the
starting set's directed reachability boundary remain at zero.

If some accounts need explicit starting influence, use a [weighted prior](./weighted-prior.md).
If you need to combine the outputs of several networks, use a [score composition](./composition.md).

## What changes over time

Vouches and revocations change the graph without a proposal. The standard creation flow always
installs DAO governance for scoring parameters and other protected settings. Each accepted
checkpoint remains part of the network's history, so a later update does not rewrite an earlier
result.

See [Create a network](./create-a-network.md) to launch one and
[Integrate proven outputs](./integrate-scores.md) to consume its output.
