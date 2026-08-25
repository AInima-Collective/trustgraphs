# Railway project definition

`.railway/railway.ts` is the single Railway Infrastructure-as-Code definition for the Sepolia
environment. It manages a small rebuildable Postgres database, the indexer, the digest-pinned
operator with persistent state, and the monitor.

Run the repository preflight before asking Railway for a plan:

```bash
pnpm railway:check
railway config plan
```

Do not run `railway config apply` until the plan has been reviewed. Omitted managed resources are
deletions in Railway IaC. The complete setup, shared-variable list, and restart drill are in
[`docs/build/railway.md`](../docs/build/railway.md).
