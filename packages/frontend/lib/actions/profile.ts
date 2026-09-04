import { decodeFunctionData, encodeFunctionData, isAddress } from 'viem'

import { merkleSnapshotAbi } from '../contract-abis'
import { isCall, isZeroValue, requiredAddress, targetMatches } from './shared'
import type {
  GovernanceActionDefinition,
  NetworkProfileActionValues,
} from './types'

export const networkProfileAction: GovernanceActionDefinition<NetworkProfileActionValues> =
  {
    key: 'update-network-profile',
    category: 'network',
    label: 'Update network profile',
    summary: 'Publish a new metadata URI for this network.',
    encode: (values, context) => {
      const metadataURI = values.metadataURI.trim()
      if (!metadataURI) throw new Error('Metadata URI is required')
      if (values.snapshot && !isAddress(values.snapshot)) {
        throw new Error('Network snapshot must be a valid address')
      }
      return [
        {
          target:
            values.snapshot ??
            requiredAddress(context.snapshot, 'Network snapshot'),
          value: '0',
          data: encodeFunctionData({
            abi: merkleSnapshotAbi,
            functionName: 'setMetadataURI',
            args: [metadataURI],
          }),
          operation: 0,
          description: 'Set the network metadata URI',
        },
      ]
    },
    match: (actions, index, context) => {
      const action = actions[index]
      if (
        !targetMatches(action, context.snapshot) ||
        !isCall(action) ||
        !isZeroValue(action)
      ) {
        return null
      }
      try {
        const decoded = decodeFunctionData({
          abi: merkleSnapshotAbi,
          data: action!.data,
        })
        if (decoded.functionName !== 'setMetadataURI') return null
        return {
          values: {
            snapshot: requiredAddress(context.snapshot, 'Network snapshot'),
            metadataURI: decoded.args[0],
          },
          consumed: 1,
        }
      } catch {
        return null
      }
    },
  }
