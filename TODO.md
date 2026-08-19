## Follow up work
- Where to find Existing binary instance id / Weighted instance id
- On weighted prior workspace, the copy is not ELI5: "Import human CSV or JSON, resolve names outside consensus, inspect the exact TGWP bytes, then create a new weighted instance or propose a timelocked prior rotation."
- Allow creating networks with additional features like governance, contributions, reward distributions etc.
- UX for network creation is not yet great, the new options should exist in flow, or be parallel paths.


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
