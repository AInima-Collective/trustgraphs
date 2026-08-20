## Network creation (program closed; see GOAL.md)
All five reported problems were fixed by the network-creation program: /create is a three-path
chooser and the wizard shows only its own steps; every creation lane exposes governance, funds,
and prepay (governed wrappers for weighted + compose; contributions rounds start from the network
page via ContributionsFactory); the weighted workspace copy passes the plain-reader test; instance
ids come from pickers with copyable surfaces; and creating a network no longer crashes the indexer
(ensure-pattern sweep + silent gov-module construction).

Residuals:
- Operator walkthrough on a real machine: click through all five creation lanes from the app with
  a wallet (in-sandbox verification covered contracts, deploy pipeline, indexer discovery, and
  cast-level creation for standard / governed / governed-weighted / contributions).
- ponder 0.16.2 upstream bug: `getIntervals` crashes at startup when the interval-query count is
  ≡1 mod 200 (drizzle `unionAll` with a single query) — the merged config triggers it. node_modules
  on this box carries a local dist patch (single-query batches call `.execute()` directly); after
  any `pnpm install`, re-apply or upgrade ponder past the fix.
- Weighted/compose rotations on a GOVERNED instance need a proposal-builder (the workspace states
  the compounded delays but still signs from the connected wallet).
- Weighted/compose instances have no settings page yet, so attach-a-fund for them has no button
  (the trust-graph Features tab has one).

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
