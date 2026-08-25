# Run the Sepolia services on Railway

The Railway project runs four resources in one region:

- a small managed Postgres database;
- one `indexer` service that follows Sepolia and serves the public Ponder API;
- the released operator, with `/data` on a persistent volume; and
- a private `monitor` service that checks both applications and the Sepolia head.

Postgres is intentionally treated as a rebuildable testnet store. The indexer and its API use
`pg`, Postgres schemas, and one shared `DATABASE_URL`, so SQLite is not a deployment switch. If the
database is lost, recreate it and let the indexer backfill from Sepolia and the configured IPFS
gateway. The operator journal is different: losing `/data/journal.jsonl` can repeat paid work, so
the `operator-state` volume is mandatory.

Railway's current project-level configuration is
[Infrastructure as Code](https://docs.railway.com/infrastructure-as-code), not the deprecated
`railway.json`/`railway.toml` format. `.railway/railway.ts` is the one complete project definition;
omitting a resource from it means deletion on the next apply.

## 1. Validate the source once

Run the offline repository checks before pushing anything:

```bash
pnpm railway:check
pnpm --dir packages/indexer exec tsc
pnpm --dir packages/frontend exec tsc --noEmit
bash scripts/secret-scan.sh
```

The operator service uses `.railway/operator.Dockerfile`, a two-file layer on top of the reviewed
operator image digest. It copies the public Sepolia policy and release manifest that Compose used
to bind-mount. It does not rebuild the operator or any guest.

The Railway services follow the `sepolia` branch. Push one reviewed, locally green commit only
after the checks above; applying before that push would make Railway build an older tree without
the Railway files.

## 2. Create the shared variables

Create these as Railway **shared variables** in the production environment. Keep the values in
Railway, not in this repository or the IaC file.

| Variable                 | Purpose                                                                |
| ------------------------ | ---------------------------------------------------------------------- |
| `RPC_URL_11155111_0`     | Primary private Sepolia RPC used by the indexer, operator, and monitor |
| `RPC_URL_11155111_1`     | Independent indexer failover RPC                                       |
| `IPFS_GATEWAY`           | Server-side gateway ending in `/ipfs/`                                 |
| `IPFS_PIN_API_KEY`       | Pinata bearer JWT                                                      |
| `SUBMITTER_PRIVATE_KEY`  | Gas-only Sepolia transaction key                                       |
| `NETWORK_PRIVATE_KEY`    | Separate Succinct prover-network key                                   |
| `OPERATOR_ALERT_WEBHOOK` | Operator and monitor alert destination                                 |

The IaC references these variables but does not create or reveal them. Postgres supplies its own
private `DATABASE_URL` through Railway's service reference.

## 3. Review the Railway plan

Install the current Railway CLI, authenticate, and link this checkout to the intended project and
production environment:

```bash
railway login
railway link
railway config plan
```

`config plan` is read-only. Expect one Postgres database, `indexer`, `operator`, `monitor`, and the
`operator-state` volume. Stop if it proposes deleting or renaming anything unexpected. The first
apply is interactive:

```bash
railway config apply
```

The project defaults to `us-west2`. Change the single `region` constant in
`.railway/railway.ts` before the first apply if another region is preferred. Do not move the
operator volume after it holds a journal.

## 4. Expose only the indexer

Generate a Railway public domain for the `indexer` service. The process listens on `PORT=65421`,
and Railway's deployment health check calls `/ready`. Record the resulting origin, without a
trailing `/sql`, as `PONDER_URL` for the frontend build; the frontend client appends `/sql` itself.

The operator and monitor stay on Railway private networking. Railway only uses configured
[deployment health checks](https://docs.railway.com/deployments/healthchecks) while bringing a
deployment online, so the monitor remains responsible for continuous readiness, stale-root, lag,
publication, and vault checks. In particular, Railway gates the operator deployment on `/health`
instead of `/ready`: the process and listener must be live, but an in-flight first network proof
cannot make the deployment time out and repeat paid work. The monitor still polls `/ready`.

Railway's private service network is IPv6. Ponder selects Node's dual-stack default automatically,
and the Railway operator profile binds `[::]:8080`; do not change it back to an IPv4-only listener.

Railway mounts service volumes as root. Its documented compatibility setting for a container that
declares a non-root user is `RAILWAY_RUN_UID=0`, so that override is scoped to the private operator
service. Do not add it to the indexer or monitor. Railway also disallows replicas on a
volume-backed service; the operator therefore has exactly one implicit replica in the volume's
region.

## 5. Prove restart recovery

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
