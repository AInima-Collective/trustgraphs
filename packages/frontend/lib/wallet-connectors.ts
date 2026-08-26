import type { CreateConnectorFn } from '@wagmi/core'
import { porto } from 'porto/wagmi'
import { coinbaseWallet, metaMask, walletConnect } from 'wagmi/connectors'

import { CHAIN } from './config'

/**
 * Vendor connectors live in their own async chunk. Do not import this module from the root
 * provider: `loadWalletConnectors()` is the single interaction-gated entry point.
 */
export const makeWalletConnectors = (): CreateConnectorFn[] => [
  // Porto has not been exercised against this Sepolia deployment. Keep the public testnet on
  // connectors whose chain-switch path is verified instead of offering a wallet that may strand
  // a creator at the final transaction.
  ...(CHAIN === 'sepolia' ? [] : [porto()]),
  metaMask(),
  coinbaseWallet(),
  walletConnect({
    projectId: '842e3d38e32065c8b0ce2622ff296651',
    metadata: {
      name: 'Trustgraphs',
      description:
        'Turn community vouches into reputation scores that apps can use and contracts can verify.',
      url: 'https://trustgraphs.xyz',
      icons: ['https://trustgraphs.xyz/images/icon-512.png'],
    },
  }),
]
