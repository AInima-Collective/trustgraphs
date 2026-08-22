import type { CreateConnectorFn } from '@wagmi/core'
import { porto } from 'porto/wagmi'
import { coinbaseWallet, metaMask, walletConnect } from 'wagmi/connectors'

/**
 * Vendor connectors live in their own async chunk. Do not import this module from the root
 * provider: `loadWalletConnectors()` is the single interaction-gated entry point.
 */
export const makeWalletConnectors = (): CreateConnectorFn[] => [
  porto(),
  metaMask(),
  coinbaseWallet(),
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
