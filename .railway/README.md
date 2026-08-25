# Railway project definition

`.railway/railway.ts` is the single Railway Infrastructure-as-Code definition for the Sepolia
environment. It manages a small rebuildable Postgres database, the indexer, the digest-pinned
operator, and its persistent state. Both application services run one replica at 0.5 vCPU, the
operator on Railway's 512 MB minimum and the indexer on 1 GB; the runbook includes the separate
managed-Postgres cap and workspace spending limit that project IaC cannot safely choose.

Run the repository preflight before asking Railway for a plan:

```bash
pnpm install --frozen-lockfile
pnpm railway:check
railway config plan
```

The globally installed Railway CLI does not provide the `railway/iac` import to Node. The frozen
install supplies the separately pinned project-local authoring SDK.

Do not run `railway config apply` until the plan has been reviewed. Omitted managed resources are
deletions in Railway IaC. The complete setup, shared-variable list, and restart drill are in
[`docs/build/railway.md`](../docs/build/railway.md).
