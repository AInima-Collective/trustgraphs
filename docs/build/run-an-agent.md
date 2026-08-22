# Run an upkeep and governance agent

An agent should have its own funded key and the smallest possible authority. Do not give it the
principal's key, a Safe owner key, or a general session key. The useful upkeep calls are already
permissionless; voting uses one explicit `MerkleGovModule` delegate assignment; EAS actions remain
human-signed.

This runbook covers the shipped v1 policy:

| Lane | Agent may do | Principal protection |
|---|---|---|
| Upkeep | execute passed proposals, claim for recipients, trigger checkpoints, run/submit proofs, fund a proving tank | Calls are permissionless and destinations are contract-bound |
| Voting | cast one provisional vote as the configured delegate | A principal vote preempts or overrides it and is final |
| Vouch/rate/respond | draft and relay EIP-712-signed EAS requests | The human signature fixes every field; the relay cannot author a vouch |
| Proposing/admin | draft only | Human/Safe authorization remains required |

## 1. Create and identify the agent key

Generate a dedicated key in a real secret manager, fund it only for expected gas, and expose it to
the process as an environment secret. The reference voting runner reads only:

```sh
export TRUSTGRAPHS_AGENT_PRIVATE_KEY=0x...
```

Never put that value in `governance-agent.json`, shell history, logs, an ERC-8004 registration
document, or a notification webhook. Rotate the key by registering the replacement operational
wallet and calling `setVoteDelegate(newAgent)` from the principal.

Pair the key with an ERC-8004 identity when public discoverability is useful. The identity registry
is presentation and provenance, not permission: make the dedicated key the current verified
`agentWallet`, retain the qualified `(chainId, registry, agentId)` identity, and describe only the
services the runner actually exposes. Registration does not prove the service is safe or live; the
on-chain `voteDelegate` mapping remains the voting authorization.

## 2. Permissionless upkeep

The commands below use Foundry's `cast`; replace placeholders with catalog/indexer values. Always
simulate against the target chain before sending, and cap the agent wallet's native balance.

Execute a proposal only after `state(proposalId)` reports `Passed` and its execution delay elapsed:

```sh
cast call "$GOV_MODULE" 'state(uint256)(uint8)' "$PROPOSAL_ID" --rpc-url "$RPC_URL"
cast send "$GOV_MODULE" 'execute(uint256)' "$PROPOSAL_ID" \
  --private-key "$TRUSTGRAPHS_AGENT_PRIVATE_KEY" --rpc-url "$RPC_URL"
```

Claim a distribution for its actual recipient. The caller never receives the payout:

```sh
cast send "$DISTRIBUTOR" 'claim(uint256,address,uint256,bytes32[])(uint256)' \
  "$DISTRIBUTION_INDEX" "$RECIPIENT" "$VALUE" "$PROOF" \
  --private-key "$TRUSTGRAPHS_AGENT_PRIVATE_KEY" --rpc-url "$RPC_URL"
```

Trigger an eligible scoring checkpoint:

```sh
cast send "$SNAPSHOT" 'trigger()(uint256)' \
  --private-key "$TRUSTGRAPHS_AGENT_PRIVATE_KEY" --rpc-url "$RPC_URL"
```

Do not hand-roll proof input selection around `submitProof`. Run the audited decision engine and
daemon in [`run-a-prover.md`](./run-a-prover.md); it handles finality, pinned params, monotonic
checkpoints, journal-bound recipients, capacity, loss budgets, and `ProvingVault.submitAndClaim`.
The same low-balance agent key can be its `SUBMITTER_PRIVATE_KEY` when operational separation is not
required.

Anyone may fund a configured proving tank; settlement still follows its instance policy:

```sh
cast send "$PROVING_VAULT" 'depositETH(bytes32)' "$INSTANCE_ID" \
  --value "$TOP_UP_WEI" --private-key "$TRUSTGRAPHS_AGENT_PRIVATE_KEY" --rpc-url "$RPC_URL"
```

Alert and stop on repeated reverts, an unexpected chain ID, changed contract addresses, a depleted
balance, a held prover instance, or a notification failure. Permissionless does not mean safe to
retry without a bound.

## 3. Configure vote delegation and notifications

Open the network's Governance page and follow "Let an agent vote for you" in the strip above the
proposals, then enter the dedicated agent address. Once a delegate is set, that spot names it
instead and "Manage" reopens the same form to change or revoke it. The UI does not enable
delegation until the user confirms receiving a test notification containing the agent's analysis
and intended vote. That confirmation is a browser-side safety rail; direct contract calls can
bypass it, so runner configuration is still the source of truth.

Copy the examples and replace every placeholder:

```sh
cp docs/examples/governance-agent.json ./governance-agent.json
cp docs/examples/governance-decisions.json ./governance-decisions.json
chmod 600 ./governance-agent.json ./governance-decisions.json
```

`notificationWebhook` must be HTTPS outside localhost. It receives no private key; it receives the
analysis, intended vote, public addresses, and a digest over that receipt. Verify delivery before
delegating:

```sh
pnpm tsx scripts/governance-agent.ts \
  --config ./governance-agent.json --test-notification
```

After the test arrives, set the delegate in the UI. The runner refuses to start unless its key is
the current on-chain delegate for `principal`.

## 4. Run the voting loop

An analysis process writes decisions to the configured JSON file. A decision is intentionally
separate from transaction authority:

```json
{
  "42": {
    "vote": "yes",
    "analysis": "The transfer matches the published budget and recipient."
  }
}
```

Run one audit-friendly pass or keep watching:

```sh
pnpm tsx scripts/governance-agent.ts --config ./governance-agent.json --once
pnpm tsx scripts/governance-agent.ts --config ./governance-agent.json
```

For each active proposal with a decision, the runner:

1. reads the proposal-pinned root and publishes an `intended-vote` receipt at the start of the
   observed window;
2. refuses to vote if notification delivery fails or the configured minimum notice window is
   already gone;
3. waits until `endBlock - castLeadBlocks` and until at least `minNoticeBlocks` have elapsed since
   successful notification;
4. checks whether the principal already voted or revoked/changed the delegate;
5. fetches the principal's public proof for the proposal-pinned root and calls
   `castVoteAsDelegate`;
6. publishes a terminal receipt (`cast`, `preempted`, `revoked`, `expired`, `cancelled`,
   `executed`, or `missed-notice`, as applicable).

Receipts are appended to the configured mode-0600 JSONL file. Each carries a `digest` over
canonical JSON; the webhook receives the same object, so a user can compare it with the local log.
The delegate's analysis is also emitted in `DelegateVoteCast` and indexed with the vote.

If the user disagrees before the late vote, they vote normally and the runner records `preempted`.
If they disagree afterward, their normal vote subtracts the provisional tally, writes their final
choice, clears `votedByDelegate`, and emits/indexes `VoteOverridden`. The agent can never overwrite a
principal vote or vote twice for the same principal/proposal.

## 5. Human-signed EAS relay

Set `NEXT_PUBLIC_EAS_RELAY_ENABLED=true` only when the server route is configured with one chain,
one EAS contract, a funded relay key, and an explicit schema allowlist. The complete environment
shape is in `packages/frontend/.env.example`.

The browser groups drafts by schema, reads the signer's current EAS nonce, and asks the human to
sign the EAS 1.3.0 `Attest` typed data in exact execution order. `/api/eas-relay` accepts at most 20
short-lived, zero-value attestations, verifies chain/contract/schema/deadline/nonces/signatures,
simulates the exact `multiAttestByDelegation` call, and only then spends relay gas. Put an external
rate limit in front of the route; its in-process limit is only a second line of defense.

There is deliberately no autonomous-vouch switch. Vouches, contribution ratings, and responses
all use this same draft-review-sign-relay path, and EAS records the signer—not the gas payer—as the
attester.

## 6. Incident response

Revocation is one principal transaction: `setVoteDelegate(address(0))`. It blocks future agent
votes but does not erase a provisional vote already cast; submit the principal's own vote before
the window closes to replace that receipt and tally. Then stop the runner, rotate the agent key and
webhook credential, preserve the JSONL receipts, and compare their digests/transaction hashes with
the indexer and chain events.
