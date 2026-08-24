# Contributions

The contributions program proves a funding allocation from two authenticated histories: the
parent network's onchain vouches and the round's contribution records. It recomputes reputation
and the allocation together; it does not consume a previously published reputation root.

A contribution record has its own meaning. Claims describe work and attribution, responses accept
or reject being named, and valuations assess eligible claims. None is treated as a vouch.

## Supported parent

A round currently requires a standard `trust-graph` parent with onchain-only EAS inputs.
Weighted-prior, composed, and hybrid offchain-vouch networks are not supported parents.

Creation is a constitutional action of the parent network, not an action available to any funder.
The caller must hold the parent snapshot's constitutional role, and the round admin must be a Safe.
For the standard governed deployment, members therefore approve round creation through the parent
DAO. Funding the distributor is a separate action.

## Round lifecycle

1. The parent authority creates a round with its time window, contribution schemas, scoring
   parameters, distributor, and Safe admin.
2. Participants submit contribution claims or nominate work by someone else.
3. Named contributors accept or reject their attribution, and raters submit valuations.
4. A checkpoint freezes both the mirrored parent vouch history and the contribution-record history.
5. One proof recomputes the canonical vouch reputation, filters and weights the valuations, and
   produces the final address allocation.

The proof excludes self-valuations and ratings from accounts below the committed minimum
reputation. It can discount collaborator conflicts, applies each rater's valuation as a budget
across eligible claims, honors contributor attribution and response rules, and can reserve a
configured share for participating evaluators.

The indexer can explain these decisions for display, but the program's committed inputs,
parameters, proof, and accepted root are the source of truth.

## Claiming an allocation

After a proof is accepted, the distributor verifies an account's value and Merkle proof against the
round root, then sends funds to the address named in that leaf. A caller cannot redirect another
account's allocation. A round may also set a deadline after which its Safe can recover unclaimed
funds.

Contribution records remain distinct from the resulting payment claim: submitting evidence or an
evaluation does not by itself grant a payout.
