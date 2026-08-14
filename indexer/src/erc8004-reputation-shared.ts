import { type Hex } from 'viem'

import { type Erc8004Position, erc8004AgentKey } from './erc8004-shared'

export type ReviewerRelationChange = Erc8004Position & {
  id: string
  agentKey: string
  account: Hex
  active: boolean
}

export type ReviewerAttributionEvidence = {
  agentKey: string
  relationEventId: string
  blockNumber: string
  transactionIndex: number
  logIndex: number
}

export type ReviewerAttribution = {
  status: 'attributed' | 'unattributed' | 'ambiguous'
  agentKey: string | null
  candidates: string[]
  evidence: ReviewerAttributionEvidence[]
}

export const compareErc8004Position = (
  a: Erc8004Position,
  b: Erc8004Position
) =>
  a.blockNumber === b.blockNumber
    ? a.transactionIndex === b.transactionIndex
      ? a.logIndex - b.logIndex
      : a.transactionIndex - b.transactionIndex
    : a.blockNumber < b.blockNumber
      ? -1
      : 1

/** Resolve only verified-wallet relations strictly before the feedback event's exact log position. */
export const attributeReviewerAt = (
  reviewer: Hex,
  feedbackPosition: Erc8004Position,
  changes: ReviewerRelationChange[]
): ReviewerAttribution => {
  const latest = new Map<string, ReviewerRelationChange>()
  for (const change of [...changes].sort(compareErc8004Position)) {
    if (change.account.toLowerCase() !== reviewer.toLowerCase()) continue
    if (compareErc8004Position(change, feedbackPosition) >= 0) continue
    latest.set(change.agentKey, change)
  }
  const active = [...latest.values()]
    .filter((change) => change.active)
    .sort((a, b) => a.agentKey.localeCompare(b.agentKey))
  const evidence = active.map((change) => ({
    agentKey: change.agentKey,
    relationEventId: change.id,
    blockNumber: change.blockNumber.toString(),
    transactionIndex: change.transactionIndex,
    logIndex: change.logIndex,
  }))
  const candidates = active.map((change) => change.agentKey)
  return active.length === 1
    ? {
        status: 'attributed',
        agentKey: active[0]!.agentKey,
        candidates,
        evidence,
      }
    : active.length === 0
      ? { status: 'unattributed', agentKey: null, candidates, evidence }
      : { status: 'ambiguous', agentKey: null, candidates, evidence }
}

export const erc8004FeedbackKey = (
  chainId: number | string,
  reputationRegistry: string,
  agentId: bigint | number | string,
  reviewer: string,
  feedbackIndex: bigint | number | string
) =>
  `feedback:eip155:${chainId}:${reputationRegistry.toLowerCase()}:${BigInt(agentId)}:${reviewer.toLowerCase()}:${BigInt(feedbackIndex)}`

export const targetAgentKey = (
  chainId: number | string,
  identityRegistry: string,
  agentId: bigint | number | string
) => erc8004AgentKey(chainId, identityRegistry, agentId)

export type ReputationReplayEvent = Erc8004Position &
  (
    | {
        kind: 'NewFeedback'
        id: string
        agentId: bigint
        reviewer: Hex
        feedbackIndex: bigint
        value: bigint
        valueDecimals: number
        tag: string
        unit: string
      }
    | {
        kind: 'FeedbackRevoked'
        id: string
        agentId: bigint
        reviewer: Hex
        feedbackIndex: bigint
      }
    | {
        kind: 'ResponseAppended'
        id: string
        agentId: bigint
        reviewer: Hex
        feedbackIndex: bigint
        responder: Hex
      }
  )

/** Pure fixture replay: revocation changes active state without deleting creation or responses. */
export const replayReputationEvents = (
  chainId: number | string,
  reputationRegistry: string,
  events: ReputationReplayEvent[]
) => {
  const feedback = new Map<
    string,
    Extract<ReputationReplayEvent, { kind: 'NewFeedback' }> & {
      revoked: boolean
      revocationEventId: string | null
      responseEventIds: string[]
    }
  >()
  for (const event of [...events].sort(compareErc8004Position)) {
    const key = erc8004FeedbackKey(
      chainId,
      reputationRegistry,
      event.agentId,
      event.reviewer,
      event.feedbackIndex
    )
    if (event.kind === 'NewFeedback') {
      feedback.set(key, {
        ...event,
        revoked: false,
        revocationEventId: null,
        responseEventIds: [],
      })
    } else {
      const current = feedback.get(key)
      if (!current) continue
      if (event.kind === 'FeedbackRevoked') {
        current.revoked = true
        current.revocationEventId = event.id
      } else {
        current.responseEventIds.push(event.id)
      }
    }
  }
  return feedback
}
