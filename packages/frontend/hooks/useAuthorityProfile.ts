import { useReadContracts } from 'wagmi'

import {
  type AuthorityProfile,
  governedWrapperAbi,
} from '@/lib/governed-wrapper'

const asBig = (value: unknown): bigint | undefined =>
  typeof value === 'bigint'
    ? value
    : typeof value === 'number'
      ? BigInt(value)
      : undefined

/**
 * Live-read the governance profile of a governed wrapper factory (voting delay/period, execution
 * delay, recovery delay) and run the sealed-authority validity check the main wizard's review
 * screen introduced. All three wrappers expose the identical read surface, so one hook serves the
 * standard wizard, the weighted workspace, and the composition workspace.
 */
export const useAuthorityProfile = (
  factory: `0x${string}` | '' | undefined
): AuthorityProfile => {
  const address =
    factory && factory.length === 42 ? (factory as `0x${string}`) : undefined
  const { data, isLoading } = useReadContracts({
    contracts: address
      ? [
          {
            address,
            abi: governedWrapperAbi,
            functionName: 'MEMBER_VOTING_DELAY',
          },
          {
            address,
            abi: governedWrapperAbi,
            functionName: 'MEMBER_VOTING_PERIOD',
          },
          {
            address,
            abi: governedWrapperAbi,
            functionName: 'MEMBER_EXECUTION_DELAY',
          },
          {
            address,
            abi: governedWrapperAbi,
            functionName: 'RECOVERY_DELAY',
          },
        ]
      : [],
    query: { enabled: !!address },
  })

  const results = (data ?? []).map((read) =>
    read.status === 'success' ? asBig(read.result) : undefined
  )
  const memberVotingDelay = results[0]
  const memberVotingPeriod = results[1]
  const memberExecutionDelay = results[2]
  const recoveryDelay = results[3]

  const valid =
    data?.length === 4 &&
    data.every((read) => read.status === 'success') &&
    memberVotingDelay !== undefined &&
    memberVotingDelay > 0n &&
    memberVotingPeriod !== undefined &&
    memberVotingPeriod > 0n &&
    memberExecutionDelay !== undefined &&
    memberExecutionDelay > 0n &&
    recoveryDelay !== undefined &&
    recoveryDelay >= 14n * 86_400n

  return {
    loading: !!address && isLoading,
    memberVotingDelay,
    memberVotingPeriod,
    memberExecutionDelay,
    recoveryDelay,
    valid,
  }
}
