import type { CreateConnectorFn } from '@wagmi/core'
import { porto } from 'porto/wagmi'
import { coinbaseWallet } from 'wagmi/connectors/coinbaseWallet'
import { metaMask } from 'wagmi/connectors/metaMask'
import { walletConnect } from 'wagmi/connectors/walletConnect'

import { CHAIN } from './config'

/**
 * Vendor connectors live in their own async chunk. Do not import this module from the root
 * provider: `loadWalletConnectors()` is the single interaction-gated entry point.
 */
export const makeWalletConnectors = (): CreateConnectorFn[] => [
  // Porto has not been qualified for public application deployments. Keep public networks on
  // connectors whose chain-switch path is verified instead of offering a wallet that may strand
  // a creator at the final transaction.
  ...(CHAIN === 'local' ? [porto()] : []),
  metaMask(),
  coinbaseWallet(),
  walletConnect({
    projectId: '4d302a761ccdd58e0ec933cbc45c7280',
    metadata: {
      name: 'Trustgraphs',
      description:
        'Turn community vouches into reputation scores that apps can use and contracts can verify.',
      url: 'https://trustgraphs.xyz',
      icons: ['https://trustgraphs.xyz/images/icon-512.png'],
    },
  }),
]
