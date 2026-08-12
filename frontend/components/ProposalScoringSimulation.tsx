'use client'

import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import type { Hex } from 'viem'

import { useNetwork } from '@/contexts/NetworkContext'
import type { ProposalAction } from '@/hooks/useGovernance'
import type { RawEdge } from '@/lib/pagerank/types'
import {
  decodeParameterUpdateAction,
  paramsFromJson,
} from '@/lib/scoring-params'
import { previewScoringChange } from '@/lib/scoring-preview'
import { usePonderQuery } from '@/lib/use-ponder-query'
import { ponderQueries, ponderQueryFns } from '@/queries/ponder'

import { ScoringGraphPreview } from './ScoringGraphPreview'

const parentHashFromDescription = (description: string): Hex | undefined => {
  const match = description.match(/Parent hash:\s*(0x[0-9a-fA-F]{64})/i)
  return match?.[1] as Hex | undefined
}

const instanceIdFor = (id: string, instanceId?: Hex): Hex | undefined =>
  instanceId ?? (/^0x[0-9a-fA-F]{64}$/.test(id) ? (id as Hex) : undefined)

export function ProposalScoringSimulation({
  actions,
  description,
  merkleRoot,
  proposalBlock,
}: {
  actions: ProposalAction[]
  description: string
  merkleRoot: string
  proposalBlock: bigint
}) {
  const { network } = useNetwork()
  const update = useMemo(
    () =>
      actions
        .map((action) => decodeParameterUpdateAction(action.data))
        .find((candidate) => candidate !== null),
    [actions]
  )
  const snapshot = network.contracts.merkleSnapshot
  const root = merkleRoot as Hex
  const instanceId = instanceIdFor(network.id, network.instanceId)
  const parentHash = parentHashFromDescription(description)

  const proof = usePonderQuery({
    queryFn: ponderQueryFns.getProofSubmission({ snapshot, root }),
    enabled: !!update && !!merkleRoot,
  })
  const checkpointId = proof.data?.checkpointId.toString() ?? ''
  const inputs = useQuery({
    ...ponderQueries.checkpointInputs(snapshot, checkpointId),
    enabled: !!update && !!checkpointId,
  })
  const history = useQuery({
    ...ponderQueries.parameterHistory(instanceId ?? ''),
    enabled: !!update && !!instanceId,
  })

  const baselineVersion = useMemo(() => {
    const versions = history.data?.versions.filter((version) => version.valid)
    if (!versions) return undefined
    if (parentHash) {
      return versions.find(
        (version) =>
          version.paramsHash.toLowerCase() === parentHash.toLowerCase()
      )
    }
    return [...versions]
      .filter((version) => BigInt(version.executedAtBlock) <= proposalBlock)
      .sort((a, b) => Number(BigInt(b.version) - BigInt(a.version)))[0]
  }, [history.data?.versions, parentHash, proposalBlock])

  const simulation = useMemo(() => {
    if (!update || !baselineVersion || !inputs.data) return undefined
    const edges: RawEdge[] = inputs.data.inputs.map((input) => ({
      kind: input.kind,
      attester: input.attester,
      recipient: input.recipient,
      uid: input.uid,
      data: input.data,
      blockTimestamp: BigInt(input.blockTimestamp),
    }))
    try {
      const current = paramsFromJson(baselineVersion.params)
      const preview = previewScoringChange({
        edges,
        current,
        proposed: update.proposed,
      })
      if (preview.currentRoot.toLowerCase() !== merkleRoot.toLowerCase()) {
        return { mismatch: true as const }
      }
      return { mismatch: false as const, preview, current }
    } catch (error) {
      console.error('Proposal scoring simulation failed', error)
      return { mismatch: true as const }
    }
  }, [baselineVersion, inputs.data, merkleRoot, update])

  if (!update) return null

  if (proof.isLoading || inputs.isLoading || history.isLoading) {
    return (
      <div
        className="border border-border bg-surface-2 p-4 text-sm text-muted-foreground"
        data-settling="true"
      >
        Recomputing proposal impact from its checkpoint…
      </div>
    )
  }

  if (simulation && !simulation.mismatch) {
    return (
      <ScoringGraphPreview
        preview={simulation.preview}
        currentSeeds={simulation.current.trustedSeeds}
        proposedSeeds={update.proposed.trustedSeeds}
      />
    )
  }

  const reason = !instanceId
    ? 'This network does not expose a catalog instance ID, so its historical parameter version cannot be verified.'
    : !proof.data
      ? 'The checkpoint that produced this proposal’s voting root is not indexed.'
      : !baselineVersion
        ? 'The proposal’s parent parameter version is not indexed.'
        : simulation?.mismatch
          ? 'The recomputed current root does not match the proposal’s voting root.'
          : 'The checkpoint evidence is temporarily unavailable.'

  return (
    <div className="border border-border bg-surface-2 p-4 text-sm">
      <p className="font-medium">Impact simulation unavailable</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {reason} The decoded parameter changes above remain available for
        review; no graph estimate is shown without reproducible evidence.
      </p>
    </div>
  )
}
