# Run the services on Railway

Trustgraphs runs one Railway project per chain. Both live in the personal workspace and are
described by the same authoring file:

| Project               | Chain                | Git branch | Regions                                                             | `FRONTEND_URL`                                                                              |
| --------------------- | -------------------- | ---------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `trustgraphs-sepolia` | Sepolia (11155111)   | `main`     | Postgres `us-west2`; operator volume and indexer replica `us-east4` | `https://trustgraphs.xyz` (becomes `https://testnet.trustgraphs.xyz` with the testnet move) |
| `trustgraphs-mainnet` | Ethereum mainnet (1) | `mainnet`  | everything `us-west2`                                               | `https://trustgraphs.xyz`                                                                   |

Each project runs the same four resources:

- a small managed Postgres database;
- one `indexer` service that follows its chain and serves the public Ponder API;
- the released operator;
- a 512 MB `operator-state` volume mounted at `/data`.

`.railway/railway.ts` does not describe a chain. The Railway CLI passes the linked project's name
as `ctx.projectName`; the file looks that name up in `.railway/targets.ts` and builds the
topology through `.railway/lib/project.ts` from the row it finds. An unknown project name is an
error that lists the known ones, so a plan cannot carry Sepolia parameters into the mainnet
project or the other way round, and adding a chain later is one more row. Everything that differs
per chain lives in the row: `DEPLOY_TARGET`, chain id, regions, git branch, writer schema, start
blocks, RPC fallbacks, frontend URL, the shared-variable names, and the memory ceilings.

The Sepolia project was created under an auto-generated name and renamed to `trustgraphs-sepolia`
in the dashboard on 2026-09-10 (Project Settings, General; a rename is non-destructive and keeps
the project id and every resource). The Sepolia row reproduces the live topology exactly, including the historical region
split: Postgres landed in `us-west2`, the operator volume and the indexer replica in `us-east4`.
Moving either stateful side is destructive (`config apply` would recreate the volume or the
database), so the split stays described as it exists and is reunified only as a deliberate
migration. Mainnet starts in one region.

Postgres is intentionally treated as a rebuildable store on both chains. The indexer and its API
use `pg`, Postgres schemas, and one shared `DATABASE_URL`, so SQLite is not a deployment switch.
If the database is lost, recreate it and let the indexer backfill from the chain and the
configured IPFS gateway. The operator journal is different: losing `/data/journal.jsonl` can
repeat paid work, so the `operator-state` volume is mandatory and must never be recreated.

Railway bills actual consumption rather than a reserved machine size. In both projects each
application service has one replica capped at 0.5 vCPU, with 1 GB of RAM for the indexer and 2 GB
for the operator. Git watch paths prevent unrelated monorepo changes from rebuilding these
services. Both services outgrew Railway's 512 MB minimum in measured ways: Ponder's start path
runs three Node processes at once and Node sizes its heap from the host's RAM rather than the
container limit, so 512 MB left the indexer killed before it logged anything; the operator derives
the vkey for every compiled-in SP1 guest at startup, which peaks past 512 MB and OOM-looped every
~25 seconds before its health listener bound. Raise a limit only for a service that shows a
measured OOM or sustained CPU cap. Replica limits bound the worst case; they do not reduce the
cost of memory or CPU the process actually consumes.

Railway's current project-level configuration is
[Infrastructure as Code](https://docs.railway.com/infrastructure-as-code), not the deprecated
`railway.json`/`railway.toml` format. `.railway/railway.ts` is the one complete project definition
for whichever project is linked; omitting a resource from it means deletion on the next apply.
Railway currently labels this IaC surface beta/experimental, so a reviewed plan is mandatory
before every apply.

## 1. Validate the source once

Run the offline repository checks before pushing anything:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm railway:check
corepack pnpm --dir packages/indexer exec tsc
corepack pnpm --dir packages/frontend exec tsc --noEmit
bash scripts/secret-scan.sh
```

`pnpm railway:check` imports the same authoring files the CLI evaluates and asserts the graph each
project would receive: both project names, every Sepolia row value, the mainnet row, both
services' `/health` checks and compute ceilings, the alchemy-first RPC list for both chains, the
operator image digest, and that `deployments/sepolia.json` is chain 11155111 and
`deployments/mainnet.json` is chain 1. It needs a Node release that strips TypeScript types
natively (22.18 or newer).

The globally installed `railway` command and the repository's `railway` package are different
pieces. The CLI evaluates `.railway/railway.ts`, while Node resolves its `railway/iac` import from
this repository's installed dependencies. If `config plan` reports `ERR_MODULE_NOT_FOUND` for
`railway`, run the frozen install above; reinstalling the global CLI does not fix that error.

The operator service uses `.railway/operator.Dockerfile`, a two-file layer on top of the reviewed
operator image digest. It copies the public operator profile and release manifest that Compose
used to bind-mount; it does not rebuild the operator or any guest. Its `DEPLOY_TARGET` build arg
selects `deployments/operator.<target>.toml` and `deployments/<target>.json` and defaults to
`sepolia`, so the Sepolia service carries no extra variable. The mainnet operator service sets
`DEPLOY_TARGET=mainnet` as a service variable, which Railway passes to the Docker build as a build
argument. Railway builds from the configured GitHub branch, so the Dockerfile and both profiles
must exist in the pushed commit of that branch; a local-only file is not present in Railway's code
archive.

The Sepolia services follow `main`. The mainnet services follow a long-lived `mainnet` branch that
is fast-forwarded on purpose, so "what runs on mainnet" is a git ref and a merge to `main` cannot
rebuild the mainnet indexer. Create that branch from the reviewed commit before the first mainnet
apply, and push one reviewed, locally green commit to the relevant branch only after the checks
above; applying before that push would make Railway build an older tree without the Railway
files.

The `v0.0.5` guest release already contains the trust-graph, weighted, composition, signer-sync,
contributions, and Nostr workspace programs. Expanding a chain's contract surface therefore does
not change their vkeys. After a factory continuation is finalized in `deployments/<target>.json`,
restart both application services once: the indexer reads factory sources from that manifest at
startup, and the operator checks each discovered instance's verifier against the matching guest
embedded in the image. Hypercerts remains outside the hosted operator; Nostr needs a separately
reviewed instance manifest rather than a generic factory deployment.

The indexer Dockerfile relies on its lockfile dependency layer rather than a BuildKit cache mount.
Railway requires cache-mount IDs to contain the Railway service ID, which does not belong in this
portable project definition.

### Rehearse and roll out an indexer upgrade

Treat any Ponder, schema, config, ABI, or indexing-function change as a new application build. Bump
the project's `writerSchema` in `.railway/targets.ts` (it becomes `PONDER_DATABASE_SCHEMA`) and
leave `PONDER_VIEWS_SCHEMA` stable. For the Sepolia v0.1 generation (replacement contracts from
block 11,670,854 plus the Ponder 0.17 upgrade), `trustgraph_sepolia_v7` is the writer and
`trust-graph` remains the public views schema. Do not reuse or delete `trustgraph_sepolia_v4`, the
writer that served the previous generation; it is the rollback source for that generation's
claims. (`v6` was abandoned mid-backfill and holds nothing.) Mainnet starts at
`trustgraph_mainnet_v1`.

The canonical EAS contract and Schema Registry sources start at `PONDER_EAS_START_BLOCK_<chainId>`,
pinned to the generation's first block: 11,670,854 on Sepolia, and on mainnet the
`firstDeploymentBlock` recorded in `deployments/mainnet.json`, which the mainnet row also passes as
`PONDER_START_BLOCK_1`. Left at its default of 0 they crawl the whole chain in 10-block
`eth_getLogs` windows, roughly 2.3 million calls per Sepolia backfill, which exhausted the metered
primary's monthly quota on 2026-09-10 and repeats with every writer-schema bump. The cost of the
bound is that the "start from existing attestations" preview only sees canonical attestations
made after that block; widen the start block deliberately when that feature needs older history,
and budget the crawl.

Before the production deploy, run the candidate image in a disposable Railway environment against
a fresh Postgres database, the production release manifest, and the production start blocks. Wait
for `/ready` to return 200, then compare `/status`, representative SQL/API responses, catalog
counts, pagination, and provenance fields with the current deployment. Restart the candidate once
and confirm that it resumes from its checkpoint without moving the finalized block backwards.

Deploy the indexer before any frontend that depends on new response fields. `/health` proves only
that the process is listening; do not treat the new writer as ready until `/ready` returns 200 and
the response comparisons pass. Ponder leaves the stable views schema pointed at the previous writer
through backfill and repoints it only after historical indexing completes. The Ponder 0.17 upgrade
does not intentionally change Trustgraphs response shapes, so the current frontend may remain live
during this rehearsal. Deploy the frontend only after the indexer checks pass.

To roll back, redeploy the last reviewed commit with its prior writer schema. Keep both writer
schemas until the release has completed its soak; never run `ponder db prune` as part of deployment
or rollback.

## 2. Link the project and set a spending ceiling

The Sepolia project already exists. For mainnet, create an empty `trustgraphs-mainnet` project
with a `production` environment. Authenticate and link this checkout explicitly to the project you
intend to plan, then confirm the link before every plan; the authoring file follows the link:

```bash
railway login
railway link --project trustgraphs-sepolia --environment production   # or trustgraphs-mainnet
railway status
railway usage limit status
```

Railway usage limits are workspace-wide, not project-local, and both projects share the personal
workspace's hard limit. A testnet overrun that trips that limit also stops the mainnet operator.
Set the workspace **Compute Usage** email alert and hard limit from the Usage page for the combined
spend of both projects, and treat a hard-limit shutdown as a mainnet incident. Railway documents
usage and replica limits under [Cost Control](https://docs.railway.com/pricing/cost-control).

Each project needs persistent storage for both managed Postgres and the operator journal. Check
the workspace plan before applying: Railway's Free plan currently allows one volume per project,
while Trial and Hobby allow enough for both. Do not upgrade to Pro merely to obtain larger compute
ceilings.

## 3. Create the shared variables

A local `.env` is not loaded by `railway config plan`. Create these as Railway **shared
variables** in each project's `production` environment. Keep the values in Railway, not in this
repository or the IaC file. The names are per chain: the RPC primary is suffixed with the chain id,
and no key is shared between the two projects.

| Variable                 | Sepolia | Mainnet | Purpose                                                                                   |
| ------------------------ | ------- | ------- | ----------------------------------------------------------------------------------------- |
| `RPC_URL_11155111_0`     | yes     |         | Primary private Sepolia RPC used by the indexer                                           |
| `RPC_URL_1_0`            |         | yes     | Primary private mainnet RPC used by the indexer                                           |
| `IPFS_GATEWAY`           | yes     | yes     | Server-side gateway ending in `/ipfs/`                                                    |
| `IPFS_PIN_API_KEY`       | yes     | yes     | Pinata bearer JWT                                                                         |
| `SUBMITTER_PRIVATE_KEY`  | yes     | yes     | Gas-only transaction key for that chain                                                   |
| `NETWORK_PRIVATE_KEY`    | yes     | yes     | Separate Succinct prover-network key                                                      |
| `OPERATOR_ALERT_WEBHOOK` |         | yes     | Passed to the mainnet operator; its profile references it as `env:OPERATOR_ALERT_WEBHOOK` |

The indexer's RPC list (`PONDER_RPC_URLS_<chainId>`) is deliberately NOT its own shared variable:
the IaC pins it to `${{shared.RPC_URL_<chainId>_0}}` (the metered primary, resolved by the
platform) followed by two independent public fallbacks, publicnode and Tenderly for the chain in
question. The list is written alchemy-first so the near-identical `PONDER_RPC_URL_<chainId>` /
`PONDER_RPC_URLS_<chainId>` names cannot be "corrected" into a pool with no independent failover:
a variable edit did exactly that twice on 2026-08-26, and the indexer launcher now refuses to
start when the list has no host independent of the primary. The operator uses publicnode directly
rather than the shared primary, because the metered free tier caps `eth_getLogs` at a 10-block
range that the operator's registry scan can never fit.

In the Railway dashboard, open **Project Settings → Shared Variables**, select the `production`
environment of the linked project, and add that project's names from the table. Seal every
credential-bearing value, including paid RPC URLs, private keys, and the Pinata token. Do not
commit `.env` to make Railway discover it.

The IaC references these variables but does not create or reveal them. Postgres supplies its own
private `DATABASE_URL` through Railway's service reference. Sepolia intentionally has no alert
webhook or dedicated monitor; inspect the operator and indexer logs during the initial soak.

The operator is intentionally fail-closed while `deployments/<target>.json` has zero instances:
`curated.single_release_instance = true` requires exactly one browser-created showcase network.
Deploying more factory types does not fabricate that network. Bring up the indexer first, create
and record the showcase network through the frontend, then deploy or restart the operator.

## 4. Review and apply the Railway plan

Use the current Railway CLI from the linked production environment:

```bash
railway status
railway config plan
```

`config plan` is read-only. Its header names the project it evaluated; stop if that is not the
one you meant. Against the Sepolia project the expected result is "already up to date": the
Sepolia row reproduces the live topology, and that no-op plan is the gate before anything is
applied to mainnet. Against the mainnet project, expect one Postgres database, `indexer`,
`operator`, and the `operator-state` volume. The mainnet row reads both start blocks from
`deployments/mainnet.json` when planned and fails with a clear error while that manifest still
carries `firstDeploymentBlock: null`, so the contracts must be deployed and recorded first. Stop
if a plan proposes deleting or renaming anything unexpected. The next apply is interactive:

```bash
railway config apply
```

On mainnet, Postgres, the two application services, and the operator volume are all placed in
`us-west2` by the row's `region` block in `.railway/targets.ts`; change it before the first apply
if another region is preferred. Do not move the operator volume after it holds a journal.

## 5. Enforce the post-apply cost controls

The IaC caps both services at one replica and 0.5 vCPU, the `indexer` at 1 GB of RAM and the
`operator` at 2 GB. Verify those values in each service's **Settings -> Deploy -> Replica Limits**
after the first apply.

Railway's managed-Postgres IaC helper supports placement but does not expose its CPU/RAM limit.
Set the `Postgres` service to the same minimum 0.5 vCPU and 512 MB in the dashboard, then rerun
`railway config plan`. Stop if the plan proposes undoing that cap. Leave the 512 MB operator volume
at its minimum until measured journal usage requires a live increase.

GitHub-backed Railway services autodeploy by default. Disable automatic deployments for `indexer`
and `operator` after the first successful deployment in each project. Deploy the latest reviewed
commit of the project's branch manually only after the local checks in step 1 pass. The IaC also
installs narrow watch paths as a second guard against unrelated monorepo rebuilds.

Do not enable Railway Serverless for these services: the indexer and operator both perform
background work even when no HTTP request arrives. After the first day, inspect Railway metrics
and raise a limit in the smallest available increment only when the current cap causes a
demonstrated failure.

## 6. Expose only the indexer

Generate a Railway public domain for the `indexer` service only:

```bash
railway domain --service indexer --port 65421
```

The process listens on `PORT=65421`, and Railway's deployment health check calls `/health`.
Ponder's `/ready` intentionally returns 503 until historical indexing completes, which can take
longer than Railway's deploy window on the minimum CPU. Record the resulting origin, without a
trailing `/sql`, as `PONDER_URL` for that chain's frontend build; the frontend client appends
`/sql` itself. Custom API domains (`api.trustgraphs.xyz`, `api.testnet.trustgraphs.xyz`) are
planned but not yet part of the IaC.

The operator stays on Railway private networking. Railway only uses configured
[deployment health checks](https://docs.railway.com/deployments/healthchecks) while bringing a
deployment online; there is no continuous protocol monitor in either project. Railway gates the
operator deployment on `/health` instead of `/ready`: the process and listener must be live, but
an in-flight first network proof cannot make the deployment time out and repeat paid work. During
the soak, inspect Railway logs and metrics and exercise the operator's `/ready` and `/status`
routes as part of the manual checks.

New Railway environments are dual-stack IPv4/IPv6; legacy environments are IPv6-only. Ponder
selects Node's dual-stack default automatically, and the Railway operator profiles bind
`[::]:8080`, which works with either Railway network generation.

Railway mounts service volumes as root. Its documented compatibility setting for a container that
declares a non-root user is `RAILWAY_RUN_UID=0`, so that override is scoped to the private operator
service. Do not add it to the indexer. Railway also disallows replicas on a volume-backed service;
the operator therefore has exactly one implicit replica in the volume's region.

## 7. Prove restart recovery

Before the first real proof, record:

```text
indexer /metrics sync block
operator /status tick_at
operator journal byte count and SHA-256
operator image base digest
```

Restart the `indexer` and confirm it returns to head. Then restart the `operator` without detaching
`operator-state`; confirm `/ready` returns, the journal checksum and prior records are unchanged,
and a new tick is appended without repeating a request. Finally leave both application services
running for the one-week soak and inspect their Railway logs and metrics at least daily.
