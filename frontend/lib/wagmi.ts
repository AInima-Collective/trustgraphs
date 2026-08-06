import { porto } from 'porto/wagmi'
import { Chain } from 'viem'
import { optimism } from 'viem/chains'
import { createConfig, fallback, http, mock, webSocket } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import {
  coinbaseWallet,
  injected,
  metaMask,
  walletConnect,
} from 'wagmi/connectors'

import { CHAIN } from './config'
import { REVIEW_FIXTURES_ENABLED } from './review-fixture-query'
import { getReviewWalletAccount } from './review-wallet-fixture'

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
      http: ['http://localhost:8545'],
      webSocket: ['ws://localhost:8545'],
    },
  },
  blockExplorers: {
    default: { name: 'Local', url: 'http://localhost:8545' },
  },
}

// Environment-based network configuration
export const getCurrentChainConfig = (): Chain => {
  if (CHAIN === 'optimism') {
    const webSocketUrl = process.env.NEXT_PUBLIC_WEBSOCKET_URL_10
    return {
      ...optimism,
      rpcUrls: {
        default: {
          http: [
            (typeof window !== 'undefined' ? window.location.origin : '') +
              '/api/rpc/10?id=0',
            (typeof window !== 'undefined' ? window.location.origin : '') +
              '/api/rpc/10?id=1',
          ],
          ...(webSocketUrl && { webSocket: [webSocketUrl] }),
        },
        provided: optimism.rpcUrls.default,
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

const supportedChains = [
  currentNetworkConfig,
  // Add ETH mainnet for ENS resolution
  mainnet,
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
      ...(CHAIN !== 'local' ? [porto()] : []),
      metaMask(),
      coinbaseWallet(),
      // Only include WalletConnect on the browser to avoid logging annoying warnings on the server.
      ...(typeof window !== 'undefined'
        ? [
            walletConnect({
              projectId: '842e3d38e32065c8b0ce2622ff296651',
              metadata: {
                name: 'Trustgraphs',
                description:
                  'Turn community vouches into reputation scores that apps can use and contracts can verify.',
                url: 'https://trustgraph.network',
                icons: ['https://trustgraph.network/images/icon-512.png'],
              },
            }),
          ]
        : []),
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
