## Network creation follow up work
- UX for network creation is not yet great, the new options (weighted prior workspace / composition workspace) should exist in flow, or be parallel paths. The sections to "open composition / weighted prior workspace" are viewable on all steps of the wizard when creating a normal workspace. Let's improve this.
- Allow creating networks with additional features like governance, contributions, reward distributions etc. (some of this is supported, but let's review.)
- On weighted prior workspace, the copy is not ELI5: "Import human CSV or JSON, resolve names outside consensus, inspect the exact TGWP bytes, then create a new weighted instance or propose a timelocked prior rotation."
- Where to find Existing binary instance id / Weighted instance id? These are referenced when creating a "weighted prior workspace", but it's unclear where to find them.
- When creating a new network there are indexer errors. The transaction succeeds onchain, but frontend gets a 500 when navigating to the new network.

## Governance
- Design Actions UI system, build a similar system to DAO DAO (both for proposing / encoding actions and viewing proposals)
- Action UI components: ERC20 (transfers, sends, etc.), NFT (transfer, etc.), trustgraph DAO settings

-----
# New work
## Audit contracts and circuits (in progress)

## Skills
We need a SKILL.md for trustgraphs.

Also, we should design a SKILL.md for trustgraph governance, so people can automate governance flows and delegate to agents.

## ERC-8003 (needs testing)
We should have a reputation network for agents!

## Graph Composition
- Show how to compose existing graphs

## More trustgraphs!
- A trustgraph for trustgraphs
- Ethereum Extitutional
- GitCoin

# Paper (attestation based governance systems)
Re-write a leaner version of the verifiable offchain governance paper more focused on trustgraphs and their applications.

# Delegation to agent
Overrule

# Future Features
- Add commitments
- More trustgraph algos
- Off-chain attestations: signed attestations without a transaction per edge
- Privacy: keep relationships and scores hidden while proving the result is correct
- Demurrage: scores decay unless trust is renewed
- Extra reputation for voting
- Eligibility applications: apply to join a network's graph
