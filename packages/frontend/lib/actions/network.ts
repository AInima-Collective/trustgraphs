import { type Address, isAddress } from 'viem'

import type { Network } from '../types'
import { realAddress } from '../utils'
import type { GovernanceActionContext } from './types'

const contractAddress = (value: string | undefined): Address | undefined => {
  const address = realAddress(value)
  return address && isAddress(address) ? address : undefined
}

const CONTRACT_LABELS: Record<
  Exclude<keyof GovernanceActionContext, 'instanceId'>,
  string
> = {
  snapshot: 'Network snapshot',
  paramsController: 'Scoring parameters controller',
  weightedParamsController: 'Weighted parameters controller',
  compositionParamsController: 'Composition parameters controller',
  signerSyncModule: 'Signer sync module',
  recoveryModule: 'Recovery module',
  executionGuard: 'Execution guard',
  treasurySafe: 'Network Safe (treasury)',
  fundDistributor: 'Rewards distributor',
  governanceModule: 'Governance module',
  provingVault: 'Proving vault',
  contributionsFactory: 'Contribution-round factory',
}

/**
 * Names for the network's own contracts, keyed by lowercase address, so composer and reviewer
 * can say "the rewards distributor" where calldata says an address.
 */
export const governanceContractLabels = (
  network: Pick<Network, 'contracts' | 'instanceId' | 'program'>
): Map<string, string> => {
  const context = governanceActionContextFor(network)
  const labels = new Map<string, string>()
  for (const [key, label] of Object.entries(CONTRACT_LABELS)) {
    const address = context[key as keyof typeof CONTRACT_LABELS]
    if (address) labels.set(address.toLowerCase(), label)
  }
  const resolver = contractAddress(network.contracts.easIndexerResolver)
  if (resolver) labels.set(resolver.toLowerCase(), 'Attestation resolver')
  const anchors = contractAddress(network.contracts.easOffchainAnchorRegistry)
  if (anchors) labels.set(anchors.toLowerCase(), 'Anchor registry')
  return labels
}

/** Build matcher context only from addresses authenticated for the network being viewed. */
export const governanceActionContextFor = (
  network: Pick<Network, 'contracts' | 'instanceId' | 'program'>
): GovernanceActionContext => {
  const controller = contractAddress(
    network.contracts.trustgraphsParamsController
  )
  const recoveryModule = contractAddress(network.contracts.safe?.recoveryModule)
  const executionGuard = contractAddress(network.contracts.safe?.executionGuard)
  const provingVault = contractAddress(network.contracts.provingVault)
  const contributionsFactory = contractAddress(
    network.contracts.contributionsFactory
  )
  return {
    ...(network.instanceId ? { instanceId: network.instanceId } : {}),
    snapshot: contractAddress(network.contracts.merkleSnapshot),
    ...(network.program === 'trust-graph-weighted'
      ? { weightedParamsController: controller }
      : network.program === 'trust-compose'
        ? { compositionParamsController: controller }
        : { paramsController: controller }),
    signerSyncModule: contractAddress(
      network.contracts.safe?.signerSyncManager
    ),
    ...(recoveryModule ? { recoveryModule } : {}),
    ...(executionGuard ? { executionGuard } : {}),
    treasurySafe: contractAddress(network.contracts.safe?.proxy),
    fundDistributor: contractAddress(network.contracts.merkleFundDistributor),
    governanceModule: contractAddress(network.contracts.merkleGovModule),
    ...(provingVault ? { provingVault } : {}),
    ...(contributionsFactory ? { contributionsFactory } : {}),
  }
}
