import { defineConfig } from '@wagmi/cli'

import { CONTRACT_CONFIG } from './lib/config'

export default defineConfig([
  // save contract ABIs to a file included in git
  {
    out: 'lib/contract-abis.ts',
    contracts: Object.keys(CONTRACT_CONFIG)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({
        abi: require(`./abis/${name}.json`).abi,
        name,
      })),
  },
  // save contract addresses to a separate file ignored by git (since these change on each development deployment)
  {
    out: 'lib/contracts.ts',
    contracts: Object.entries(CONTRACT_CONFIG)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, address]) => ({
        abi: require(`./abis/${name}.json`).abi,
        name,
        ...(address ? { address: address as `0x${string}` } : {}),
      })),
  },
])
