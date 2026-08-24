# Contributions

The contributions program allocates a funding pool using community assessments weighted by
proven reputation. It connects a trust network to a round where people can submit contributions,
respond to nominations, and evaluate eligible work.

## Round lifecycle

1. A funder creates a round and defines its time window and scoring rules.
2. Participants submit contributions or nominate work by someone else.
3. The contributor accepts or rejects nominations, and eligible members submit valuations.
4. A proof combines the trust network's reputation checkpoint with the round records.
5. The resulting Merkle root defines each account's allocation from the pool.

Reputation comes from the linked trust network, not from activity inside the funding round. The
calculation excludes or discounts records such as self-evaluations, rejected nominations, and
ineligible activity according to the round's committed parameters.

## Claims

After the proof is accepted, the distributor verifies each allocation against the root and sends
funds to the account named in the leaf. A claimant cannot redirect another account's allocation.
Rounds may also define a deadline after which unclaimed funds return to the funder.

The indexer can explain an allocation for display, but the accepted proof and onchain root remain
the source of truth.
