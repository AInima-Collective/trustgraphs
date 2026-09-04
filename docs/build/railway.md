# Run the Sepolia services on Railway

The Railway project runs four resources in `us-west2`:

- a small managed Postgres database;
- one `indexer` service that follows Sepolia and serves the public Ponder API;
- the released operator;
- a 512 MB `operator-state` volume mounted at `/data`.

Postgres is intentionally treated as a rebuildable testnet store. The indexer and its API use
`pg`, Postgres schemas, and one shared `DATABASE_URL`, so SQLite is not a deployment switch. If the
database is lost, recreate it and let the indexer backfill from Sepolia and the configured IPFS
gateway. The operator journal is different: losing `/data/journal.jsonl` can repeat paid work, so
the `operator-state` volume is mandatory.

Railway bills actual consumption rather than a reserved machine size. Each application service has
one replica capped at 0.5 vCPU, with 512 MB of RAM for the operator and 1 GB for the indexer. Git
watch paths prevent unrelated monorepo changes from rebuilding these services. Start at those limits
and raise only the service that shows a measured OOM or sustained CPU cap. The indexer already has:
Ponder's start path runs three Node processes at once and Node sizes its heap from the host's RAM
rather than the container limit, so 512 MB left it killed before it logged anything. Replica limits bound the worst case; they do
not reduce the cost of memory or CPU the process actually consumes.

Railway's current project-level configuration is
[Infrastructure as Code](https://docs.railway.com/infrastructure-as-code), not the deprecated
`railway.json`/`railway.toml` format. `.railway/railway.ts` is the one complete project definition;
omitting a resource from it means deletion on the next apply. Railway currently labels this IaC
surface beta/experimental, so a reviewed plan is mandatory before every apply.

## 1. Validate the source once

Run the offline repository checks before pushing anything:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm railway:check
corepack pnpm --dir packages/indexer exec tsc
corepack pnpm --dir packages/frontend exec tsc --noEmit
bash scripts/secret-scan.sh
```

The globally installed `railway` command and the repository's `railway` package are different
pieces. The CLI evaluates `.railway/railway.ts`, while Node resolves its `railway/iac` import from
this repository's installed dependencies. If `config plan` reports `ERR_MODULE_NOT_FOUND` for
`railway`, run the frozen install above; reinstalling the global CLI does not fix that error.

The operator service uses `.railway/operator.Dockerfile`, a two-file layer on top of the reviewed
operator image digest. It copies the public Sepolia policy and release manifest that Compose used
to bind-mount. It does not rebuild the operator or any guest. Railway builds from the configured
GitHub branch, so this Dockerfile must exist in the pushed `main` commit; a local-only file is
not present in Railway's code archive.

The `v0.0.5` guest release already contains the trust-graph, weighted, composition, signer-sync,
contributions, and Nostr workspace programs. Expanding the Sepolia contract surface therefore does
not change their vkeys. After the weighted, composition, and contributions continuation is
finalized in `deployments/sepolia.json`, restart both application services once: the indexer reads
factory sources from that manifest at startup, and the operator checks each discovered instance's
verifier against the matching guest embedded in the image. Hypercerts remains outside the hosted
operator; Nostr needs a separately reviewed instance manifest rather than a generic factory
deployment.

The indexer Dockerfile relies on its lockfile dependency layer rather than a BuildKit cache mount.
Railway requires cache-mount IDs to contain the Railway service ID, which does not belong in this
portable project definition.

The Railway services follow the `main` branch. Push one reviewed, locally green commit only
after the checks above; applying before that push would make Railway build an older tree without
the Railway files.

### Rehearse and roll out an indexer upgrade

Treat any Ponder, schema, config, ABI, or indexing-function change as a new application build. Bump
`PONDER_DATABASE_SCHEMA` in `.railway/railway.ts` and leave `PONDER_VIEWS_SCHEMA` stable. For the
Ponder 0.17 upgrade, `trustgraph_sepolia_v5` is the new writer and `trust-graph` remains the public
views schema. Do not reuse or delete `trustgraph_sepolia_v4`; it is the rollback source.

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

## 2. Select the project and set a spending ceiling

Create an empty `trustgraphs-sepolia` project with a `production` environment. Authenticate and
link this checkout explicitly so a plan cannot target a similarly named environment by accident:

```bash
railway login
railway link --project trustgraphs-sepolia --environment production
railway usage limit status
```

Before applying, set a Railway **Compute Usage** email alert and hard limit from the workspace
Usage page. The limit is workspace-wide, not project-local, so account for any other workloads in
that workspace. On a dedicated testnet workspace, choose the smallest hard dollar limit whose
automatic shutdown you are willing to accept. Railway documents usage and replica limits under
[Cost Control](https://docs.railway.com/pricing/cost-control).

This topology needs persistent storage for both managed Postgres and the operator journal. Check
the workspace plan before applying: Railway's Free plan currently allows one volume per project,
while Trial and Hobby allow enough for both. Do not upgrade to Pro for this testnet merely to obtain
larger compute ceilings.

## 3. Create the shared variables

A local `.env` is not loaded by `railway config plan`. Create these as Railway **shared
variables** in the environment you linked above (`production` in this guide). Keep the values in
Railway, not in this repository or the IaC file.

| Variable                | Purpose                                                      |
| ----------------------- | ------------------------------------------------------------ |
| `RPC_URL_11155111_0`    | Primary private Sepolia RPC used by the indexer and operator |
| `IPFS_GATEWAY`          | Server-side gateway ending in `/ipfs/`                       |
| `IPFS_PIN_API_KEY`      | Pinata bearer JWT                                            |
| `SUBMITTER_PRIVATE_KEY` | Gas-only Sepolia transaction key                             |
| `NETWORK_PRIVATE_KEY`   | Separate Succinct prover-network key                         |

The indexer's RPC list (`PONDER_RPC_URLS_11155111`) is deliberately NOT its own shared variable:
the IaC pins it to `${{shared.RPC_URL_11155111_0}}` (the metered primary, resolved by the
platform) followed by the two independent public fallbacks (publicnode + Tenderly). The list is
written alchemy-first so the near-identical `PONDER_RPC_URL_11155111` / `PONDER_RPC_URLS_11155111`
names cannot be "corrected" into a pool with no independent failover — a variable edit did
exactly that twice on 2026-08-26, and the indexer launcher now refuses to start when the list has
no host independent of the primary.

In the Railway dashboard, open **Project Settings → Shared Variables**, select the linked
environment, and add the five names above. Seal every credential-bearing value, including paid
RPC URLs, private keys, and the Pinata token. Do not commit `.env` to make Railway discover it.

The IaC references these variables but does not create or reveal them. Postgres supplies its own
private `DATABASE_URL` through Railway's service reference. This first testnet intentionally has
no alert webhook or dedicated monitor; inspect the operator and indexer logs during the initial
soak.

The operator is intentionally fail-closed while `deployments/sepolia.json` has zero instances:
`curated.single_release_instance = true` requires exactly one browser-created showcase network.
Deploying more factory types does not fabricate that network. Bring up the indexer first, create
and record the showcase network through the frontend, then deploy or restart the operator.

## 4. Review and apply the Railway plan

Use the current Railway CLI from the linked production environment:

```bash
railway config plan
```

`config plan` is read-only. Expect one Postgres database, `indexer`, `operator`, and the
`operator-state` volume. Stop if it proposes deleting or renaming anything unexpected. The first
failed apply may have created a failed `monitor` service; deleting only that service is expected
after simplifying the topology. The next apply is interactive:

```bash
railway config apply
```

Postgres, the two application services, and the operator volume are placed in `us-west2`. The
single `region` constant in `.railway/railway.ts` controls that placement; change it before the
first apply if another region is preferred. Do not move the operator volume after it holds a
journal.

## 5. Enforce the post-apply cost controls

The IaC caps both services at one replica and 0.5 vCPU, the `operator` at 512 MB of RAM and the
`indexer` at 1 GB. Verify those values in each service's **Settings -> Deploy -> Replica Limits**
after the first apply.

Railway's managed-Postgres IaC helper supports placement but does not expose its CPU/RAM limit.
Set the `Postgres` service to the same minimum 0.5 vCPU and 512 MB in the dashboard, then rerun
`railway config plan`. Stop if the plan proposes undoing that cap. Leave the 512 MB operator volume
at its minimum until measured journal usage requires a live increase.

GitHub-backed Railway services autodeploy by default. Disable automatic deployments for `indexer`
and `operator` after the first successful deployment. Deploy the latest reviewed `sepolia` commit
manually only after the local checks in step 1 pass. The IaC also installs narrow watch paths as a
second guard against unrelated monorepo rebuilds.

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
longer than Railway's deploy window on the minimum testnet CPU. Record the resulting origin,
without a trailing `/sql`, as `PONDER_URL` for the frontend build; the frontend client appends
`/sql` itself.

The operator stays on Railway private networking. Railway only uses configured
[deployment health checks](https://docs.railway.com/deployments/healthchecks) while bringing a
deployment online; this intentionally simple first testnet has no continuous protocol monitor.
Railway gates the operator deployment on `/health` instead of `/ready`: the process and listener
must be live, but an in-flight first network proof cannot make the deployment time out and repeat
paid work. During the soak, inspect Railway logs and metrics and exercise the operator's `/ready`
and `/status` routes as part of the manual checks.

New Railway environments are dual-stack IPv4/IPv6; legacy environments are IPv6-only. Ponder
selects Node's dual-stack default automatically, and the Railway operator profile binds
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
