# Test graph lineages locally

Run the focused contract and deterministic fixture suites:

```sh
forge test --match-path test/unit/GraphLineageRegistry.t.sol -vv
pnpm --dir indexer test
pnpm --dir frontend test
```

`test/fixtures/graph-lineage.json` contains A→B→C→A referral history, a revocation, an expired
edge, a pre-rotation issuer configuration, evidence and warning kinds, correlated family/method/
controller records, mutable evidence, and a second scope. The TypeScript fold proves that only
active referral records enter adjacency and reports unused mass exactly. The Solidity fixture also
tests identical names/roots across qualified identities, unauthorized issuance, sequence replay,
wrong scope/version, supersession, authority/params/program rotation, the `1e18` budget, exact
checkpoint identity, overlapping future referral windows, and byte-identical root state before and
after endorsements.

For a live smoke test, deploy the script from the runbook against local Anvil, register three
factory instances, issue the fixture's cycle, and open `/graph-lineages`. Rotate one controller
owner without syncing: the API and UI must show the affected records suspended. Stop the RPC and
reload: candidate-active records must become `verification-unavailable`, not active.
