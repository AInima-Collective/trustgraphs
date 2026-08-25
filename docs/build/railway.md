# Run the Sepolia services on Railway

The Railway project runs five resources in `us-west2`:

- a small managed Postgres database;
- one `indexer` service that follows Sepolia and serves the public Ponder API;
- the released operator;
- a private `monitor` service that checks both applications and the Sepolia head; and
- a 512 MB `operator-state` volume mounted at `/data`.

Postgres is intentionally treated as a rebuildable testnet store. The indexer and its API use
`pg`, Postgres schemas, and one shared `DATABASE_URL`, so SQLite is not a deployment switch. If the
database is lost, recreate it and let the indexer backfill from Sepolia and the configured IPFS
gateway. The operator journal is different: losing `/data/journal.jsonl` can repeat paid work, so
the `operator-state` volume is mandatory.

Railway bills actual consumption rather than a reserved machine size. Each application service has
one replica capped at Railway's current minimum of 0.5 vCPU and 512 MB RAM. The monitor has its own
minimal image and Git watch paths prevent unrelated monorepo changes from rebuilding these services.
Start at those limits and raise only the service that shows a measured OOM or sustained CPU cap.
Replica limits bound the worst case; they do not reduce the cost of memory or CPU the process
actually consumes.

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
to bind-mount. It does not rebuild the operator or any guest.

The Railway services follow the `sepolia` branch. Push one reviewed, locally green commit only
after the checks above; applying before that push would make Railway build an older tree without
the Railway files.

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

| Variable                | Purpose                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| `RPC_URL_11155111_0`    | Primary private Sepolia RPC used by the indexer, operator, and monitor |
| `RPC_URL_11155111_1`    | Independent indexer failover RPC                                       |
| `IPFS_GATEWAY`          | Server-side gateway ending in `/ipfs/`                                 |
| `IPFS_PIN_API_KEY`      | Pinata bearer JWT                                                      |
| `SUBMITTER_PRIVATE_KEY` | Gas-only Sepolia transaction key                                       |
| `NETWORK_PRIVATE_KEY`   | Separate Succinct prover-network key                                   |

In the Railway dashboard, open **Project Settings → Shared Variables**, select the linked
environment, and add the six names above. Seal every credential-bearing value, including paid
RPC URLs, private keys, and the Pinata token. Do not commit `.env` to make Railway discover it.

The IaC references these variables but does not create or reveal them. Postgres supplies its own
private `DATABASE_URL` through Railway's service reference. This first testnet intentionally has
no alert webhook: the operator and monitor write alerts to Railway logs instead.

## 4. Review and apply the Railway plan

Use the current Railway CLI from the linked production environment:

```bash
railway config plan
```

`config plan` is read-only. Expect one Postgres database, `indexer`, `operator`, `monitor`, and the
`operator-state` volume. Stop if it proposes deleting or renaming anything unexpected. The first
apply is interactive:

```bash
railway config apply
```

Postgres, the three application services, and the operator volume are placed in `us-west2`. The
single `region` constant in `.railway/railway.ts` controls that placement; change it before the
first apply if another region is preferred. Do not move the operator volume after it holds a
journal.

## 5. Enforce the post-apply cost controls

The IaC caps `indexer`, `operator`, and `monitor` at one replica with 0.5 vCPU and 512 MB RAM. Verify
those values in each service's **Settings -> Deploy -> Replica Limits** after the first apply.

Railway's managed-Postgres IaC helper supports placement but does not expose its CPU/RAM limit.
Set the `Postgres` service to the same minimum 0.5 vCPU and 512 MB in the dashboard, then rerun
`railway config plan`. Stop if the plan proposes undoing that cap. Leave the 512 MB operator volume
at its minimum until measured journal usage requires a live increase.

GitHub-backed Railway services autodeploy by default. Disable automatic deployments for `indexer`,
`operator`, and `monitor` after the first successful deployment. Deploy the latest reviewed
`sepolia` commit manually only after the local checks in step 1 pass. The IaC also installs narrow
watch paths as a second guard against unrelated monorepo rebuilds.

Do not enable Railway Serverless for these services: the indexer, operator, and monitor all perform
background work even when no HTTP request arrives. After the first day, inspect Railway metrics and
raise a limit in the smallest available increment only when the current cap causes a demonstrated
failure.

## 6. Expose only the indexer

Generate a Railway public domain for the `indexer` service only:

```bash
railway domain --service indexer --port 65421
```

The process listens on `PORT=65421`, and Railway's deployment health check calls `/ready`. Record
the resulting origin, without a trailing `/sql`, as `PONDER_URL` for the frontend build; the
frontend client appends `/sql` itself.

The operator and monitor stay on Railway private networking. Railway only uses configured
[deployment health checks](https://docs.railway.com/deployments/healthchecks) while bringing a
deployment online, so the monitor remains responsible for continuous readiness, stale-root, lag,
publication, and vault checks. In particular, Railway gates the operator deployment on `/health`
instead of `/ready`: the process and listener must be live, but an in-flight first network proof
cannot make the deployment time out and repeat paid work. The monitor still polls `/ready`.

New Railway environments are dual-stack IPv4/IPv6; legacy environments are IPv6-only. Ponder
selects Node's dual-stack default automatically, and the Railway operator profile binds
`[::]:8080`, which works with either Railway network generation.

Railway mounts service volumes as root. Its documented compatibility setting for a container that
declares a non-root user is `RAILWAY_RUN_UID=0`, so that override is scoped to the private operator
service. Do not add it to the indexer or monitor. Railway also disallows replicas on a
volume-backed service; the operator therefore has exactly one implicit replica in the volume's
region.

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
and a new tick is appended without repeating a request. Finally leave all three application
services under the monitor for the goal's one-week soak.
