import type { EventNames, IndexingFunctionArgs } from 'ponder:registry'
import type { Hex } from 'viem'

const defaultFrontendOrigin = (env: NodeJS.ProcessEnv): string =>
  env.DEPLOY_ENV?.trim().toUpperCase() === 'PROD'
    ? 'https://trustgraph.network'
    : 'http://127.0.0.1:3000'

/** The app origin whose cache the indexer invalidates after an indexed state change. */
export const frontendOrigin = (env: NodeJS.ProcessEnv = process.env): string =>
  (env.FRONTEND_URL?.trim() || defaultFrontendOrigin(env)).replace(/\/+$/, '')

export const revalidationUrl = (
  networkId: string,
  env: NodeJS.ProcessEnv = process.env
): string =>
  `${frontendOrigin(env)}/api/revalidate/${encodeURIComponent(networkId)}`

export const revalidateNetwork = async (networkId: string = 'all') => {
  try {
    const response = await fetch(revalidationUrl(networkId), {
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) {
      console.error(
        `Error revalidating networks: ${response.status} ${response.statusText}`
      )
    }
  } catch (err) {
    console.error('Error revalidating networks', err)
  }
}

/**
 * Handler args for an event that is registered on MORE THAN ONE source.
 *
 * The snapshot and fund-distributor contracts each live on two Ponder sources: the
 * factory-discovered one (every trust-graph instance the `TrustgraphsFactory` minted —
 * `merkleSnapshot`, `merkleFundDistributor`) and the static one (the contributions and hypercerts
 * instances, deployed by their own scripts — `programSnapshot`, `programFundDistributor`). Ponder's
 * `address` is either a static list or a `factory()`, never both, hence the pair; the handler is
 * written once and registered twice.
 *
 * `event` keeps its real type (identical across the pair — same ABI, same event). `context` is
 * loosened because the two `Context` types differ structurally only in which config entry they were
 * derived from, and a single implementation has to satisfy both.
 */
export type SharedArgs<name extends EventNames> = {
  event: IndexingFunctionArgs<name>['event']
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any
}

/**
 * A source's configured addresses, or `[]` when it is a factory source. Factory children have no
 * addresses at config time — that is the point — so a `setup` handler (which runs at the source's
 * start block, before any instance exists) has nothing to do for them.
 */
export const staticAddresses = (address: unknown): Hex[] =>
  Array.isArray(address) ? (address as Hex[]) : []
