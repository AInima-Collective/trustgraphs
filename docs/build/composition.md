# Score compositions

A score composition combines the accepted outputs of several trustgraphs networks into a new,
verifiable allocation. It is useful when an application wants to draw on multiple communities or
methods without merging their raw vouches or changing any source network.

## Choose source networks

Open `/create/composition` to select between two and eight source networks. A source must:

- be on the same chain as the other sources;
- have at least one accepted score root;
- publish address-based allocations; and
- expose the provenance needed to authenticate its history.

Standard and weighted trust graphs can both be composed, but the current version keeps those score
types in separate compositions. An unavailable, stale, or ineligible source is shown explicitly
and cannot be substituted with another network.

## Set the allocation policy

Each source receives a percentage of the final allocation. Equal weights are the default. The
preview normalizes different point scales into those governed quotas and shows how every source
contributes to each account's result.

The preview also highlights overlap, concentration, correlation, and sensitivity to removing a
source. These are decision aids, not proof that a chosen policy is fair or that its publishers are
independent.

Before the wallet request, the app simulates the transaction and commits to the exact policy and
source set that were previewed. If a transaction-invalid input changes, the simulation must be run
again. Policy cautions remain visible but do not require disclaimer checkboxes.

## Update a composition

Creation and policy changes are separate workflows. Create the composition once, then use
`/compositions/:instanceId/settings` to propose, cancel, or activate a new policy. Updates follow
the composition controller's review delay and do not rewrite earlier epochs.

## Verify the result

Every epoch records the source checkpoints, policy, output file, CID, and Merkle root. The
composition detail page preserves that history and provides address proofs. If a required source
cannot be authenticated or fetched, capture fails instead of redistributing its quota.

See [Integrate scores](./integrate-scores.md) to verify a composed allocation in an application.
