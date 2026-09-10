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

// Contract ABIs, committed to git. Addresses are not generated: call sites read
// them from CONTRACT_CONFIG (config.json) at runtime.
export default defineConfig({
  out: 'lib/contract-abis.ts',
  contracts: Object.keys(CONTRACT_CONFIG)
    .filter((name) => !ABI_NOT_GENERATED.has(name))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      abi: require(`./abis/${name}.json`).abi,
      name,
    })),
})
