import {
  type Address,
  BaseError,
  type Hex,
  type PublicClient,
  isHex,
} from 'viem'

import type { SafeAction } from '@/lib/actions'

export type SimulationLeg = {
  status: 'success' | 'revert' | 'skipped'
  reason?: string
  gasUsed?: bigint
}

export type ProposalSimulation = {
  /** `batch` ran the legs in order with state carried over; `sequential` ran each alone. */
  method: 'batch' | 'sequential'
  legs: SimulationLeg[]
}

const DELEGATECALL_NOTE =
  'Delegatecalls run in the Safe’s own storage and are not simulated.'

const revertDataOf = (error: unknown): Hex | undefined => {
  if (!(error instanceof BaseError)) return undefined
  const found = error.walk(
    (candidate) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      'data' in candidate &&
      typeof (candidate as { data?: unknown }).data === 'string'
  ) as { data?: string } | null
  const data = found?.data
  return typeof data === 'string' && isHex(data) && data.length >= 10
    ? data
    : undefined
}

const reasonOf = (
  error: unknown,
  data: Hex | undefined,
  describe: (data: Hex) => string | null
): string => {
  const described = data ? describe(data) : null
  if (described) return described
  if (error instanceof BaseError) return error.shortMessage
  if (error instanceof Error) return error.message
  return 'Reverted without a reason.'
}

const unsupported = (error: unknown) => {
  const message =
    error instanceof Error ? `${error.message} ${error.name}` : String(error)
  return /eth_simulateV1|not supported|not found|unsupported|does not exist|-32601/i.test(
    message
  )
}

/**
 * Dry-run a proposal's legs from the Safe. Prefers one batch simulation so later legs see
 * earlier ones (an approval before a distribution); falls back to independent per-leg calls on
 * nodes without eth_simulateV1, and says so.
 */
export const simulateGovernanceActions = async (
  client: PublicClient,
  params: {
    safe: Address
    actions: readonly SafeAction[]
    describeRevert: (data: Hex) => string | null
  }
): Promise<ProposalSimulation> => {
  const { safe, actions, describeRevert } = params
  const simulatable = actions
    .map((action, index) => ({ action, index }))
    .filter(({ action }) => action.operation !== 1)
  const legs: SimulationLeg[] = actions.map((action) =>
    action.operation === 1
      ? { status: 'skipped', reason: DELEGATECALL_NOTE }
      : { status: 'skipped' }
  )
  if (!simulatable.length) return { method: 'batch', legs }

  try {
    const result = await client.simulateCalls({
      account: safe,
      calls: simulatable.map(({ action }) => ({
        to: action.target,
        data: action.data,
        value: BigInt(action.value || '0'),
      })),
    })
    simulatable.forEach(({ index }, position) => {
      const outcome = result.results[position]
      if (!outcome) return
      if (outcome.status === 'success') {
        legs[index] = { status: 'success', gasUsed: outcome.gasUsed }
      } else {
        const data =
          typeof outcome.data === 'string' && outcome.data.length >= 10
            ? outcome.data
            : revertDataOf(outcome.error)
        legs[index] = {
          status: 'revert',
          reason: reasonOf(outcome.error, data, describeRevert),
        }
      }
    })
    return { method: 'batch', legs }
  } catch (error) {
    if (!unsupported(error)) {
      // A batch that failed as a whole (bad block, RPC hiccup) still yields per-leg answers below.
    }
  }

  for (const { action, index } of simulatable) {
    try {
      await client.call({
        account: safe,
        to: action.target,
        data: action.data,
        value: BigInt(action.value || '0'),
      })
      legs[index] = { status: 'success' }
    } catch (error) {
      legs[index] = {
        status: 'revert',
        reason: reasonOf(error, revertDataOf(error), describeRevert),
      }
    }
  }
  return { method: 'sequential', legs }
}
