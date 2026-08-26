import type { Connector, CreateConnectorFn } from '@wagmi/core'
import { Chain } from 'viem'
import { sepolia } from 'viem/chains'
import { createConfig, fallback, http, mock, webSocket } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'

import { CHAIN } from './config'
import { REVIEW_FIXTURES_ENABLED } from './review-fixture-query'
import { getReviewWalletAccount } from './review-wallet-fixture'

const localRpcUrl =
  process.env.NEXT_PUBLIC_RPC_URL_31337 || 'http://localhost:8545'
const localWebSocketUrl =
  process.env.NEXT_PUBLIC_WEBSOCKET_URL_31337 ||
  localRpcUrl.replace(/^http/, 'ws')

export const localChain: Chain = {
  id: 31337, // Anvil default chain ID
  name: 'Local Anvil',
  nativeCurrency: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  },
  rpcUrls: {
    default: {
      http: [localRpcUrl],
      webSocket: [localWebSocketUrl],
    },
  },
  blockExplorers: {
    default: { name: 'Local', url: localRpcUrl },
  },
}

// Environment-based network configuration
export const getCurrentChainConfig = (): Chain => {
  if (CHAIN === 'sepolia') {
    const publicChain = sepolia
    const chainId = publicChain.id
    const webSocketUrl =
      process.env[`NEXT_PUBLIC_WEBSOCKET_URL_${publicChain.id}`]
    return {
      ...publicChain,
      rpcUrls: {
        default: {
          http: [
            (typeof window !== 'undefined' ? window.location.origin : '') +
              `/api/rpc/${chainId}?id=0`,
            (typeof window !== 'undefined' ? window.location.origin : '') +
              `/api/rpc/${chainId}?id=1`,
          ],
          ...(webSocketUrl && { webSocket: [webSocketUrl] }),
        },
        provided: publicChain.rpcUrls.default,
      },
    }
  } else if (CHAIN === 'local') {
    return localChain
  } else {
    throw new Error(`Unsupported chain: ${CHAIN}`)
  }
}

// Get the current network configuration
export const currentNetworkConfig = getCurrentChainConfig()

const getEnsMainnetConfig = (): Chain => {
  const proxyUrl =
    (typeof window !== 'undefined' ? window.location.origin : '') + '/api/rpc/1'
  const serverRpcUrl =
    typeof window === 'undefined' ? process.env.RPC_URL_1 : undefined
  const publicUrls = mainnet.rpcUrls.default.http
  const httpUrls =
    typeof window === 'undefined'
      ? serverRpcUrl
        ? [serverRpcUrl]
        : publicUrls
      : [proxyUrl]

  return {
    ...mainnet,
    rpcUrls: {
      ...mainnet.rpcUrls,
      default: { ...mainnet.rpcUrls.default, http: httpUrls },
    },
  }
}

const supportedChains = [
  currentNetworkConfig,
  // ENS registry and Universal Resolver calls always run on Ethereum mainnet.
  getEnsMainnetConfig(),
] as readonly [Chain, ...Chain[]]

let wagmiConfig: ReturnType<typeof _makeWagmiConfig> | undefined
/**
 * Make the Wagmi config object. This should ideally only be called in the client side because WalletConnect uses some client-side only dependencies and logs annoying warnings on the server.
 */
export const makeWagmiConfig = () => {
  if (!wagmiConfig) {
    wagmiConfig = _makeWagmiConfig()
  }
  return wagmiConfig
}
export const _makeWagmiConfig = () =>
  createConfig({
    // Keep the server snapshot through hydration, then restore connector state on mount. Review
    // personas are chosen from browser storage and would otherwise change the nav and round DOM
    // before React can hydrate the server's disconnected markup.
    ssr: true,
    chains: supportedChains,
    connectors: [
      ...(REVIEW_FIXTURES_ENABLED
        ? [
            mock({
              accounts: [getReviewWalletAccount()],
              features: { defaultConnected: true, reconnect: true },
            }),
          ]
        : []),
      injected(),
    ],
    transports: supportedChains.reduce(
      (acc, chain) => {
        const transports = [
          ...(chain.rpcUrls.default.webSocket?.map((url) => webSocket(url)) ||
            []),
          ...(chain.rpcUrls.default.http.map((url) => http(url)) || []),
        ]

        acc[chain.id] =
          transports.length > 1 ? fallback(transports) : transports[0]
        return acc
      },
      {} as Record<number, any>
    ),
  })

let walletConnectorsPromise: Promise<void> | undefined

/**
 * Add vendor-backed wallet choices after a person explicitly opens the wallet picker.
 *
 * Keeping this dynamic import out of the root provider is intentional. Constructing the
 * Coinbase, MetaMask, Porto/Reown and WalletConnect connectors asks those SDKs for providers;
 * doing that during hydration made every read-only page download their chunks and contact their
 * telemetry/config endpoints. The eager `injected()` connector above remains enough for browser
 * extensions (including EIP-6963 providers) and lets previously-authorized injected wallets
 * reconnect without a click.
 *
 * wagmi exposes connector setup through `_internal` because its own `connect()` and `reconnect()`
 * actions use the same path when handed a connector factory. Updating the connector store keeps
 * the existing config, connections and clients intact, and `useConnectors()` observes the new
 * choices without remounting the application.
 */
export const loadWalletConnectors = (): Promise<void> => {
  if (typeof window === 'undefined' || CHAIN === 'local') {
    return Promise.resolve()
  }
  if (walletConnectorsPromise) return walletConnectorsPromise

  walletConnectorsPromise = import('./wallet-connectors')
    .then(({ makeWalletConnectors }) => {
      const config = makeWagmiConfig()
      const added = makeWalletConnectors().map((factory: CreateConnectorFn) =>
        config._internal.connectors.setup(factory)
      )

      config._internal.connectors.setState((current) => {
        const ids = new Set(current.map((connector) => connector.id))
        const rdns = new Set(
          current.flatMap((connector) =>
            connector.rdns
              ? Array.isArray(connector.rdns)
                ? connector.rdns
                : [connector.rdns]
              : []
          )
        )

        const unique = added.filter((connector: Connector) => {
          if (ids.has(connector.id)) return false
          const connectorRdns = connector.rdns
            ? Array.isArray(connector.rdns)
              ? connector.rdns
              : [connector.rdns]
            : []
          if (connectorRdns.some((value) => rdns.has(value))) return false

          ids.add(connector.id)
          connectorRdns.forEach((value) => rdns.add(value))
          return true
        })

        return [...current, ...unique]
      })
    })
    .catch((error) => {
      // A transient chunk/network failure should be retryable on the next picker open.
      walletConnectorsPromise = undefined
      throw error
    })

  return walletConnectorsPromise
}

// Export utility functions for network management
export const getTargetChainId = (): number => {
  return currentNetworkConfig.id
}

export const getTargetChainConfig = (): Chain => {
  return currentNetworkConfig
}

export const createNetworkAddParams = (config: Chain) => {
  return {
    chainId: `0x${config.id.toString(16)}`,
    chainName: config.name,
    nativeCurrency: config.nativeCurrency,
    rpcUrls: config.rpcUrls.provided?.http || config.rpcUrls.default.http,
    blockExplorerUrls: config.blockExplorers?.default?.url
      ? [config.blockExplorers.default.url]
      : undefined,
  }
}

declare module 'wagmi' {
  interface Register {
    config: ReturnType<typeof makeWagmiConfig>
  }
}
