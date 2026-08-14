# Deploy to production (advanced)

> **No production deployment exists today** — the repo is set up for local testing, and the
> config that ships is the development template. When a real production network launches,
> create `config/networks.production.json` from
> [`config/networks.development.template.json`](../../config/networks.development.template.json)
> and follow this page.

### Deploy new network

Create `config/networks.production.json` (copy the development template) with the new
network's metadata set, but leave the contracts and schemas blank — they are filled in by
the deployment script.

Set the ZK deployment parameters in your environment (see `deploy/env.ts` and `.env.example`):

- `SP1_PROGRAM_VKEY` — the guest program verification key (`cargo run -p trustgraph-prover -- trust-graph vkey`)
- `SP1_SIGNER_PROGRAM_VKEY` / `SELECTION_PARAMS_HASH` — the signer-sync equivalents (see the
  [signer-sync runbook](./signer-sync/runbook.md))
- `SP1_VERIFIER_GATEWAY` — the canonical SP1 verifier gateway on the target chain
- `NETWORK_EPOCH_LENGTH` — a nonzero block count between score checkpoints for each network
  created through the legacy production deploy path (for example, `1296000` is about 30 days on
  Optimism). The deploy fails closed when this is missing or zero.

There is **no `PARAMS_HASH` env var**: `DeployNetwork` computes the params hash on-chain from
`params.json` (the same file the prover feeds the guest) right after it registers the schema —
see the note in `.env.example`.

Then deploy the contracts, which will deploy and fill in the missing values:

```bash
pnpm deploy:contracts
```

This deploys EAS + resolvers, the `SP1JournalVerifier`, `MerkleSnapshot` (with the accumulator and
the two-tier governance timelocks), the Zodiac `MerkleGovModule` Safe, and the reward distributor.

### Run the prover

The `{account → score}` root is produced by a permissionless SP1 proof — anyone can post `(root, proof)`
via `MerkleSnapshot.submitProof`. Real STARK → Groth16 proving needs ≥16–32 GiB of RAM or the Succinct
prover network (`SP1_PROVER=network`). See [`trust-graph/runbook.md`](./trust-graph/runbook.md) for the guest/host build
and the checkpoint → prove → submit flow.

In production that loop is not driven by hand. Deploy the **proof scheduler** and it keeps every
instance's scores fresh with nobody watching: [`run-a-prover.md`](./run-a-prover.md) is the whole
contract — what it does, how to configure it, what it alerts on, and how to recover it.

Four things to get right before the first tick:

1. **`registry_from_block`.** Set it to the `InstanceRegistry` deployment block. Left at 0 the
   daemon scans from genesis, which most providers reject outright as an archive request — the
   failure is not slowness, it is no catalog and every tick failing. Startup alerts if you forget.
2. **Two keys, separately funded.** `NETWORK_PRIVATE_KEY` (prover network requester) and
   `SUBMITTER_PRIVATE_KEY` (submit gas). They are split because the payee lives in the journal, so
   the submitting key holds no value and rotates freely.
3. **A real Groth16 proof, verified by the canonical gateway, before anything else.** This is the
   one thing the build could not exercise (11 GiB box, no network key — [`DEVIATIONS`](../../research/DEVIATIONS.md)
   #20). Every proof in CI wraps at a mock gateway. Prove one checkpoint for real, submit it, watch
   it land, and only then start the daemon.
4. **Independent score-blob durability.** Configure at least two independently operated
   `[[ipfs.targets]]` and set `ipfs.min_success = 2`. Each target needs a kubo-compatible add API
   and the gateway readers actually use; the operator reads the exact bytes back before permitting
   proof submission. A CID is a content identity, not a storage SLA. Contract for retention at
   least as long as the root may be queried, keep an offline backup of every canonical blob (or
   the checkpoint inputs and historical params needed to reproduce it), and test
   `operator republish --instance <id> --checkpoint <id>` before launch. Two endpoints backed by
   the same storage failure domain do not count as independent.

### The accumulator ceiling — enforce, monitor, and recover

**The fact.** Both lane-1 accumulator leaves (every attestation and revocation appends one) and
lane-2 anchors grow monotonically; a chained hash cannot be trimmed. Proving cost scales with
`leafCount + anchorCount`. `ProvingVault`, bounded `AnchorRegistry`, and the operator share the
absolute **`MAX_PRICED_INPUTS = 200,000`** boundary. A new anchor is rejected before the fold when it
would exceed the registry's lower immutable `maxTotalInputs`; choose that cap below 200,000 on a
two-lane instance to reserve the planned lane-1 budget. Separately gate or price lane-1 EAS ingress.

**Attacker cost (order of magnitude, mainnet).** Each lane-1 leaf is one EAS attestation or
revocation through the resolver (~120–180k gas). Filling the ceiling from scratch is therefore
~200k transactions ≈ 25–35B gas — roughly **25–350 ETH** across the 1–10 gwei range: expensive as
vandalism, cheap as a targeted attack on a high-value instance, and rate-limitable only by ingress
pricing. Lane-2 `anchor()` is not permissionless: only governance-admitted `ANCHORER_ROLE` relayers
may append, all node kinds require increasing counts, and address heads also require the owner's
signature. Forge traces put a first admitted append at ~88–93k transaction gas, with repeated
updates to nonzero slots cheaper. An unaffiliated caller always reverts before changing the count; mass
self-registration changes no proving input. A compromised admitted relayer can still consume the
configured finite capacity, so use independent relayers, monitor role changes, and set a cap from
the expected lifetime budget. Full analysis: [`research/ANCHOR_INGRESS.md`](../../research/ANCHOR_INGRESS.md).

**What this means for the first experiments.** A bounded lane-2 instance cannot have its fee band
moved by an unaffiliated address. It does trust admitted relayers for inclusion/liveness, so grant at
least two independent operators and alert on role changes. An instance whose lane-1 attestation
ingress is open to adversaries must still price or stake that ingress (the payable resolver exists
for this) before real value depends on the scores.

**Monitoring (in place).** The proof scheduler reads a bounded registry's `maxTotalInputs` and
alerts (webhook + `input_ceiling_approaching` log event + status page) when
`leafCount + anchorCount` crosses **80%** of that cap. Legacy/no-lane-2 implementations fall back to
200,000. Do not silence the alert: revoke unexpected ingress and start migration while an orderly
final checkpoint still fits.

**Recovery path (prepare BEFORE launch).** Both input-lane setters are available only before
checkpoint 0. Re-seed by deploying a fresh resolver/accumulator, bounded registry, verifier, and
snapshot; preserve the old final root, CID bytes, params, checkpoint block, and addresses as
migration evidence; update the same instance-directory row; then have the old snapshot's
constitutional authority call `ProvingVault.migrate`. Directory events preserve the generation
link and the old contracts remain queryable. Re-register identities and re-anchor/re-attest only
live inputs. Budget `timelock delay + deployment + re-ingress + first proof` before the 100% point.
The exact ceremony and rollback checks are in
[`research/ANCHOR_INGRESS.md`](../../research/ANCHOR_INGRESS.md).

### Run the indexer

The indexer has two production processes: a versioned writer and a stable read server. Set:

```bash
PONDER_RPC_URL_<chainId>=https://your-archive-capable-rpc   # note: the production profile in
                                        # indexer/ponder.config.ts is currently pinned to chain 10
                                        # (reads PONDER_RPC_URL_10); the go-forward production
                                        # chain is Ethereum mainnet (chain 1)
PONDER_START_BLOCK_<chainId>=<earliest configured contract deployment block>
PONDER_DATABASE_SCHEMA=trustgraph_v1   # change for every indexing-code release
PONDER_VIEWS_SCHEMA=trust-graph         # stable; the frontend reads this
DATABASE_URL=postgresql://...
IPFS_GATEWAY=https://.../ipfs/
FRONTEND_URL=https://your-app.example   # defaults to https://trustgraph.network in PROD
```

Then run `docker compose -f docker-compose.prod.yml up -d`. The writer backfills into the versioned
schema and only publishes the stable views after it is ready. `ponder-server` waits for that
readiness signal and serves port 65421; a writer crash or restart does not take the last completed
read schema away.

Startup refuses three unsafe states before Ponder runs: the wrong chain id, deployment-summary
addresses with no code, or an RPC that cannot answer historical state at the start block. It also
records a finalized block hash in Postgres. A later production identity mismatch is never reset
automatically—verify the RPC/database and deploy to a new versioned schema. Use
`pnpm --dir indexer preflight` for the same checks without starting Ponder.

### Run the proving vault

Optional, and only if you intend to pay for roots or let communities pay for their own.
[`ProvingVault`](../../src/contracts/vault/ProvingVault.sol) is the tank a community tops up so
somebody keeps proving its scores; [`IProvingVault`](../../src/interfaces/vault/IProvingVault.sol)
documents why each piece is shaped the way it is. Deploy order and the settings that matter:

```
ProvingVault(registry, usdc, ethUsdFeed, feedMaxStaleness, minEthUsd, maxEthUsd, feeSetter, admin)
```

- **The price feed must be 8-decimal** — the constructor asserts it. An 18-decimal feed would
  underpay every prover by 1e10.
- **`minEthUsd` / `maxEthUsd` are a sanity band, not decoration.** `maxPerRootUsd` is denominated
  in oracle-USD and the ETH leg converts at the same oracle, so a low-but-fresh price caps nothing:
  at $1/ETH a $50 claim withdraws 50 ETH. An out-of-band answer is treated as no answer.
- **Price the bands before anyone creates an instance** (`setFeePerRootUsd(program, band, usd)`),
  or the first roots land and pay nothing. Band 0 is reserved for "we do not price this" and
  refuses to be set. `GovernedTrustgraphsFactory` rejects a prepaid creation while trust-graph band
  1 is zero; the app also shows the current band-1 price before signing.
- **The factory's `vault` constructor argument** is what makes `createInstance` payable, so a
  community can fund its network during creation. Passing zero means "no prepay path", and sending
  value to such a factory reverts rather than being kept.

The app's governed path takes an explicit initial `minPaidIntervalBlocks` and `maxPerRootUsd`, routes
the ETH through its bootstrap Safe, and has that Safe call `setPolicy` before handing bootstrap
ownership to the creator. A nonzero deposit with a zero policy, a policy without a deposit, a paid
interval shorter than the initial score epoch, an initial cap below band 1 or above $10,000, and an
unpriced band 1 all revert atomically. Zero/zero means unpaid or curated and opens no vault account.

Communities can later change their limits with `setPolicy(instanceId, minPaidIntervalBlocks,
maxPerRootUsd)`. That remains the only enforceable paid cadence: `EPOCH_FLOOR` binds at creation
only, since `setEpochLength` is constitutional and a community can change its own epoch afterwards.
Unused funds are not app-withdrawable: the constitutional Safe must request a withdrawal and wait
the vault's advertised notice before executing it.
