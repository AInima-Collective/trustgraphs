import path from 'path'

import dotenv from 'dotenv'
import { createConfig } from 'ponder'
import { Hex } from 'viem'

import deploymentSummary from '../.docker/deployment_summary.json'
import {
  easIndexerResolverAbi,
  gnosisSafeAbi,
  merkleFundDistributorAbi,
  merkleGovModuleAbi,
  merkleSnapshotAbi,
  wavsIndexerAbi,
} from '../frontend/lib/contract-abis'

const dotenvFile = path.join(__dirname, '../.env')
const { parsed: { DEPLOY_ENV } = {} } = dotenv.config({
  path: dotenvFile,
  quiet: true,
})

if (!DEPLOY_ENV) {
  throw new Error(`Failed to load DEPLOY_ENV from ${dotenvFile}`)
}

export const IS_PRODUCTION = DEPLOY_ENV.toUpperCase().trim() === 'PROD'
const CORE_CHAIN = IS_PRODUCTION ? 'optimism' : 'local'

export default createConfig({
  ordering: 'multichain',
  chains: {
    ...(!IS_PRODUCTION
      ? {
          local: {
            id: 31337,
            rpc: 'http://localhost:8545',
            ws: 'ws://localhost:8545',
          },
        }
      : {
          optimism: {
            id: 10,
            rpc: process.env.PONDER_RPC_URL_10,
            ws: process.env.PONDER_WS_URL_10,
          },
        }),
  },
  contracts: {
    wavsIndexer: {
      abi: wavsIndexerAbi,
      startBlock: IS_PRODUCTION ? 142786355 : 1,
      chain: {
        [CORE_CHAIN]: { address: deploymentSummary.wavs_indexer as Hex },
      },
    },
    easIndexerResolver: {
      abi: easIndexerResolverAbi,
      startBlock: IS_PRODUCTION ? 142786483 : 1,
      chain: {
        [CORE_CHAIN]: {
          address: deploymentSummary.networks.map(
            (network) => network.contracts.easIndexerResolver as Hex
          ),
        },
      },
    },
    merkleSnapshot: {
      abi: merkleSnapshotAbi,
      startBlock: IS_PRODUCTION ? 142786328 : 1,
      chain: {
        [CORE_CHAIN]: {
          address: deploymentSummary.networks.map(
            (network) => network.contracts.merkleSnapshot as Hex
          ),
        },
      },
    },
    merkleGovModule: {
      abi: merkleGovModuleAbi,
      startBlock: IS_PRODUCTION ? 0 : 'latest',
      chain: deploymentSummary.networks.some(
        (network) => network.contracts.merkleGovModule
      )
        ? {
            [CORE_CHAIN]: {
              address: deploymentSummary.networks.flatMap(
                (network) => (network.contracts.merkleGovModule as Hex) || []
              ),
            },
          }
        : {},
    },
    merkleFundDistributor: {
      abi: merkleFundDistributorAbi,
      startBlock: IS_PRODUCTION ? 0 : 'latest',
      chain: deploymentSummary.networks.some(
        (network) => network.contracts.merkleFundDistributor
      )
        ? {
            [CORE_CHAIN]: {
              address: deploymentSummary.networks.flatMap(
                (network) =>
                  (network.contracts.merkleFundDistributor as Hex) || []
              ),
            },
          }
        : {},
    },
    gnosisSafe: {
      abi: gnosisSafeAbi,
      startBlock: IS_PRODUCTION ? 146706138 : 'latest',
      chain: deploymentSummary.networks.some(
        (network) => network.contracts.safe?.proxy
      )
        ? {
            [CORE_CHAIN]: {
              address: deploymentSummary.networks.flatMap(
                (network) => (network.contracts.safe?.proxy as Hex) || []
              ),
            },
          }
        : {},
    },
  },
})
