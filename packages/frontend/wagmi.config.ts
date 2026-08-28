import { defineConfig } from '@wagmi/cli'

import { CONTRACT_CONFIG } from './lib/config'

// Contracts whose address is still needed from config.json but whose generated
// ABI has no importer: reads go through hand-rolled minimal ABIs
// (lib/settings-contracts.ts) or the indexer's own narrowed copies instead.
const ABI_NOT_GENERATED = new Set([
  'ProvingVault',
  'SchemaRegistrar',
  'SchemaRegistry',
])

export default defineConfig([
  // save contract ABIs to a file included in git
  {
    out: 'lib/contract-abis.ts',
    contracts: Object.keys(CONTRACT_CONFIG)
      .filter((name) => !ABI_NOT_GENERATED.has(name))
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
