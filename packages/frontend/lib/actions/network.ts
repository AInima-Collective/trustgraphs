import { type Address, isAddress } from 'viem'

import type { Network } from '../types'
import { realAddress } from '../utils'
import type { GovernanceActionContext } from './types'

const contractAddress = (value: string | undefined): Address | undefined => {
  const address = realAddress(value)
  return address && isAddress(address) ? address : undefined
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
