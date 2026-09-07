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

## Composing an action

The composer never asks for a raw contract value. Each action declares its fields in
`lib/actions/fields.ts`, and every field has a kind that fixes how it is entered, checked, and
shown to reviewers:

| Kind                   | Entered as                                                                                                                    | Stored as                       | Shown as                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------- |
| `address`              | Address or ENS name, with pickers for Safe owners, modules, role holders, allowlisted funders and the network's own contracts | Checksummed address             | ENS name, link, and the contract's name when it is one of the network's |
| `amount`               | Decimal tokens, with the treasury balance and a Max button                                                                    | Base units                      | `1,500 USDC`                                                            |
| `ether`                | Decimal ETH                                                                                                                   | Decimal ETH, encoded to wei     | `1.25 ETH`                                                              |
| `timestamp`            | Date and time picker, presets, and a "No expiry" toggle where zero is legal                                                   | Unix seconds                    | `2026-09-30 14:00 UTC (in ~23 days)`                                    |
| `blocks`               | A duration in minutes, hours or days, or a block count                                                                        | Block count                     | `14,400 blocks (~2 days)`                                               |
| `percent`, `bps`       | Percentage with a slider                                                                                                      | `1e18` fraction or basis points | `2.5%`                                                                  |
| `usd`                  | Dollars                                                                                                                       | USD × 1e8                       | `$250.00`                                                               |
| `boolean`, `operation` | Two named states side by side, with the live state underneath                                                                 | Boolean, 0 or 1                 | The chosen state                                                        |
| `bytes32`              | Hex, or a choice from proven score roots or queued recovery actions                                                           | 32-byte hex                     | Copyable hash                                                           |
| `params`               | A structured form over the network's live scoring tuple, with a change summary and a JSON view                                | Exact params JSON               | Damping, trusted accounts, iterations                                   |

Fields that replace a live setting show the current value and warn when the draft equals it.
Problems appear beside the field they belong to (`GovernanceActionFieldError` from the encoder,
or the synchronous schema check) once the field has been touched, or all at once when review is
attempted. Some values are never typed: a Safe owner swap or module removal derives the
linked-list predecessor from the live Safe, a contribution round attaches the parent's scoring
tuple and a random salt, and the weighted controller comes from the network.

A custom call can be built from an ABI: the network's own contracts bring theirs, any other
target takes a pasted JSON or human-readable ABI, and the raw calldata stays available. Reviewers
see custom calls against known contracts decoded to function and arguments.

The review step dry-runs every leg from the treasury (`eth_simulateV1`, falling back to one
`eth_call` per leg and saying so) and reports which would revert, decoding the reason against the
network's ABIs. High-impact actions list their consequence
(`lib/actions/danger.ts`) and must be acknowledged before the proposal can be submitted.

## Add an action

1. Add its value type and its encode/match definition in the relevant category module. Use one
   definition in both directions.
2. Require network-owned addresses from `GovernanceActionContext`. Never accept a draft-supplied
   controller, Safe, module, snapshot, distributor, vault, factory, recovery module, or guard as
   authority.
3. Before decoding, verify the target, `operation`, and ETH value. Verify cross-leg relationships
   for a span, including token, amount, spender, and ordering.
4. Register the matcher before `customAction`. Add the composer metadata, availability rule,
   defaults, field specs in `fields.ts`, encoding branch, and read-only presentation.
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

| Category   | Action checklist                | State to verify after execution                                                      |
| ---------- | ------------------------------- | ------------------------------------------------------------------------------------ |
| Treasury   | Send ETH                        | Recipient balance increases by the exact wei value.                                  |
| Treasury   | Send ERC-20                     | Recipient token balance increases by the exact base-unit amount.                     |
| Treasury   | Fund rewards                    | The approval and distribution remain one two-leg card; the distribution is recorded. |
| Treasury   | Pause/resume rewards            | Distributor paused state matches the proposal.                                       |
| Treasury   | Set fee recipient               | Distributor fee recipient matches the proposed address.                              |
| Treasury   | Set fee percentage              | Active or pending fee state matches the encoded fixed-point value.                   |
| Treasury   | Enable/disable allowlist        | Distributor allowlist flag matches the proposal.                                     |
| Treasury   | Update funder allowance         | The selected funder's allowance matches the proposal.                                |
| Network    | Update profile                  | The snapshot's metadata URI and indexed network profile update.                      |
| Membership | Grant/revoke operational role   | `hasRole(OPERATIONAL_ROLE, account)` matches the proposal.                           |
| Membership | Propose constitutional transfer | The proposed successor and transfer delay are visible.                               |
| Membership | Cancel constitutional transfer  | The pending constitutional handoff is cleared.                                       |
| Governance | Set quorum                      | The module reports the proposed fixed-point quorum.                                  |
| Governance | Set voting delay                | The module reports the proposed block delay.                                         |
| Governance | Set voting period               | The module reports the proposed positive voting period.                              |
| Governance | Set execution delay             | The module reports the proposed block delay.                                         |
| Governance | Update delegatecall allowlist   | The selected target's allowlist state matches the proposal.                          |
| Governance | Cancel proposal                 | Create a separate unexecuted proposal first; its state becomes cancelled.            |

Finally, inspect one proposal's indexed API response. Its actions must still be neutral tuples with
their descriptions intact. Friendly labels belong to the client-side registry; the indexer does
not reinterpret calldata.

For the voter and execution model, see [Governance and network authority](../learn/governance.md).
