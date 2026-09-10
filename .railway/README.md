# Railway project definitions

`.railway/railway.ts` is the single Railway Infrastructure-as-Code entry point for every hosted
Trustgraphs chain. It does not describe a chain itself: it looks the linked Railway project's name
up in `.railway/targets.ts` and hands the row it finds to `.railway/lib/project.ts`, which builds
the same four resources for every chain from that row: a small rebuildable Postgres database, the
`indexer`, the digest-pinned `operator`, and the `operator-state` volume that holds its journal.

| File                  | Role                                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `railway.ts`          | `defineRailway`: `TARGETS[ctx.projectName]`, or throw listing the known projects                                                                                                    |
| `targets.ts`          | one row per Railway project: `DEPLOY_TARGET`, chain id, regions, git branch, writer schema, start blocks, RPC fallbacks, frontend URL, shared-variable names, memory ceilings       |
| `lib/project.ts`      | `trustgraphsProject(ctx, target)`: the topology, parameterised by the row                                                                                                           |
| `operator.Dockerfile` | the two-file layer over the released operator image; its `DEPLOY_TARGET` build arg (default `sepolia`) selects `deployments/operator.<target>.toml` and `deployments/<target>.json` |
| `package.json`        | marks the directory as ES modules so Node, `tsc` and the Railway CLI agree on the module format                                                                                     |

Known projects: `trustgraphs-sepolia` and `trustgraphs-mainnet`, by their dashboard names. A plan against any
other project fails before it reaches Railway, so Sepolia parameters cannot land in the mainnet
project or the other way round. A third chain is one more row plus its `deployments/<target>.json`.

Both application services run one replica at 0.5 vCPU, the indexer on 1 GB and the operator on
2 GB, in both projects. The Sepolia row reproduces the live topology exactly, including its
historical region split; mainnet uses one region.

Link the checkout to the project you intend to plan. The file follows the link, not a flag:

```bash
pnpm install --frozen-lockfile
pnpm railway:check
railway link --project trustgraphs-sepolia --environment production   # or trustgraphs-mainnet
railway status                                                        # confirm before planning
railway config plan
```

The globally installed Railway CLI does not provide the `railway/iac` import to Node. The frozen
install supplies the separately pinned project-local authoring SDK. `pnpm railway:check` imports
the same authoring files the CLI evaluates and asserts the graph each project would receive, so it
needs a Node release that strips TypeScript types natively (22.18 or newer).

Do not run `railway config apply` until the plan has been reviewed. Omitted managed resources are
deletions in Railway IaC. The complete setup, the per-project shared-variable lists, and the
restart drill are in [`docs/build/railway.md`](../docs/build/railway.md).
