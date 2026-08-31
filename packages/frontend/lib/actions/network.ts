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
  network: Pick<Network, 'contracts'>
): GovernanceActionContext => ({
  paramsController: contractAddress(
    network.contracts.trustgraphsParamsController
  ),
  signerSyncModule: contractAddress(network.contracts.safe?.signerSyncManager),
})
