import { queryOptions } from '@tanstack/react-query'

export type PublicOperatorAction = {
  action:
    | 'idle'
    | 'trigger'
    | 'await_finality'
    | 'prove'
    | 'submit'
    | 'hold'
    | 'skip'
  reason: string | null
  checkpointId: number | null
  confirmations: number | null
  requiredConfirmations: number | null
  boundaryBlock: number | null
}

export type PublicOperatorSettings = {
  paidEnabled: boolean | null
  paidVault: string | null
  paidRecipient: string | null
  tickSeconds: number | null
  subsidyMinBlocks: number | null
  maxConcurrent: number | null
  maxPerInstance: number | null
  maxBasefeeGwei: number | null
  replacementAfterSeconds: number | null
  simulateBeforeSend: boolean | null
  confirmations: number | null
  tracksBlockHash: boolean | null
  proverBackend: string | null
  groth16: boolean | null
  proofTimeoutSeconds: number | null
  perInstanceUsdPerDay: number | null
  globalUsdPerDay: number | null
  budgetWindowSeconds: number | null
  publishesScores: boolean | null
  verifiesScoreReadback: boolean | null
}

export type PublicOperatorStatus =
  | { available: false }
  | {
      available: true
      chainId: number | null
      headBlock: number | null
      tickAt: number | null
      instance: {
        name: string | null
        program: string | null
        snapshot: string | null
        curated: boolean | null
        action: PublicOperatorAction | null
        blocksSinceRoot: number | null
      } | null
      settings: PublicOperatorSettings | null
    }

export const operatorStatusQuery = (instanceId: string) =>
  queryOptions({
    queryKey: ['operator-status', instanceId] as const,
    queryFn: async (): Promise<PublicOperatorStatus> => {
      const response = await fetch(`/api/operator-status/${instanceId}`, {
        cache: 'no-store',
      })
      if (!response.ok) {
        throw new Error(`Operator status responded ${response.status}`)
      }
      return (await response.json()) as PublicOperatorStatus
    },
    enabled: /^0x[0-9a-fA-F]{64}$/.test(instanceId),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
