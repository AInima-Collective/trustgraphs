# Build and verify governance actions

Trustgraphs governance proposals contain exact Safe transaction tuples. The action library gives
those tuples typed forms when a proposal is created and typed, calldata-derived cards when it is
reviewed. This guide explains the trust boundary, how to add an action, and how to exercise the
complete proposal lifecycle on a local stack.

## The durable boundary

The neutral onchain and indexer representation is a `SafeAction`:

```ts
type SafeAction = {
  target: Address
  value: string
  data: Hex
  operation: 0 | 1
  description?: string
}
```

The description is proposer-written annotation. The viewer does not trust it to identify an
action. A typed matcher must decode calldata, check call type and value, and verify every
network-owned target against the authenticated network context. A familiar selector sent to a
different contract stays a raw custom call.

Some typed actions consume more than one consecutive tuple. Funding ERC-20 rewards, for example,
is an approval followed by a distributor call. The registry matches the whole span or renders its
legs as custom calls; it does not present a partial span as the friendly action.

The implementation lives in `packages/frontend/lib/actions/`:

- `types.ts` defines the shared tuple, context, and action interfaces;
- one category file owns each action's encoder and matcher;
- `composer.ts` owns JSON-safe form values and action availability;
- `registry.ts` defines matching order and the custom-call fallback;
- `network.ts` derives only authenticated runtime addresses; and
- `fixtures/wave-one.json` freezes the initial library's calldata and decoded presentation.

## Add an action

1. Add its value type and its encode/match definition in the relevant category module. Use one
   definition in both directions.
2. Require network-owned addresses from `GovernanceActionContext`. Never accept a draft-supplied
   controller, Safe, module, snapshot, distributor, vault, factory, recovery module, or guard as
   authority.
3. Before decoding, verify the target, `operation`, and ETH value. Verify cross-leg relationships
   for a span, including token, amount, spender, and ordering.
4. Register the matcher before `customAction`. Add the composer metadata, availability rule,
   defaults, editor fields, encoding branch, and read-only presentation.
5. Mark authority transfers, module/guard changes, cancellation, delegatecall, and asset recovery
   as danger-tier actions so both create and review surfaces show the warning frame.
6. Add a round-trip test and a wrong-target fixture. If the action is part of a stable public wave,
   add it to the golden corpus as well.

Run the focused suite while developing:

```bash
pnpm --filter trustgraphs-frontend test:actions
pnpm --filter trustgraphs-frontend exec tsc --noEmit --pretty false
```

## Golden decode corpus

The wave-one corpus covers every treasury, network-profile, membership, and governance-settings
action. Each case freezes:

- the editable composer draft;
- exact targets, values, calldata, operations, and action descriptions;
- the typed values reconstructed after neutral JSON transport;
- multi-leg span length; and
- which authenticated leg must fall back to custom when its target is spoofed.

The normal action test fails if current encoding or decoding differs from the committed corpus.
When an intentional ABI or presentation-boundary change is reviewed, regenerate and inspect the
fixture in the same change:

```bash
pnpm --filter trustgraphs-frontend fixtures:governance-actions:write
git diff -- packages/frontend/lib/actions/fixtures/wave-one.json
pnpm --filter trustgraphs-frontend test:actions
```

Do not refresh a golden fixture merely to make a failure disappear. First decide whether old
proposals must still decode and whether changing the transaction bytes is intended.

## Cold-stack proposal walkthrough

Start from [Run trustgraphs locally](./quickstart.md). Use `anvil --block-time 1`, complete
`task demo`, then start the indexer and frontend. Restart both after a new deployment so they read
the current contract sources. Connect a seeded Anvil member with voting power and open the demo
network's Governance tab.

For each row in the wave-one checklist below, use a fresh proposal and complete the same lifecycle:

1. Choose **Create proposal**, add the typed action, enter the values, and inspect the exact call
   preview before submitting.
2. Open the proposal detail. Confirm the action is already rendered as the same typed action and
   that its target is the network contract shown in the deployment/catalog data.
3. Vote with enough scored members to meet quorum. Mine through the voting and execution delays
   when needed with `cast rpc anvil_mine <blocks> --rpc-url http://127.0.0.1:8545`.
4. Execute from the proposal page. Confirm the transaction succeeds and the affected contract
   state changes.
5. Wait for the indexer, reload the executed proposal, and confirm review still shows the typed
   card from indexed calldata, including its final status and exact values.

Use reversible values and a fresh demo deployment before testing authority-transfer or
delegatecall cases. Fund the Safe before transfer tests, and give it the selected ERC-20 before a
token transfer or ERC-20 reward distribution.

| Category | Action checklist | State to verify after execution |
| --- | --- | --- |
| Treasury | Send ETH | Recipient balance increases by the exact wei value. |
| Treasury | Send ERC-20 | Recipient token balance increases by the exact base-unit amount. |
| Treasury | Fund rewards | The approval and distribution remain one two-leg card; the distribution is recorded. |
| Treasury | Pause/resume rewards | Distributor paused state matches the proposal. |
| Treasury | Set fee recipient | Distributor fee recipient matches the proposed address. |
| Treasury | Set fee percentage | Active or pending fee state matches the encoded fixed-point value. |
| Treasury | Enable/disable allowlist | Distributor allowlist flag matches the proposal. |
| Treasury | Update funder allowance | The selected funder's allowance matches the proposal. |
| Network | Update profile | The snapshot's metadata URI and indexed network profile update. |
| Membership | Grant/revoke operational role | `hasRole(OPERATIONAL_ROLE, account)` matches the proposal. |
| Membership | Propose constitutional transfer | The proposed successor and transfer delay are visible. |
| Membership | Cancel constitutional transfer | The pending constitutional handoff is cleared. |
| Governance | Set quorum | The module reports the proposed fixed-point quorum. |
| Governance | Set voting delay | The module reports the proposed block delay. |
| Governance | Set voting period | The module reports the proposed positive voting period. |
| Governance | Set execution delay | The module reports the proposed block delay. |
| Governance | Update delegatecall allowlist | The selected target's allowlist state matches the proposal. |
| Governance | Cancel proposal | Create a separate unexecuted proposal first; its state becomes cancelled. |

Finally, inspect one proposal's indexed API response. Its actions must still be neutral tuples with
their descriptions intact. Friendly labels belong to the client-side registry; the indexer does
not reinterpret calldata.

For the voter and execution model, see [Governance and network authority](../learn/governance.md).
