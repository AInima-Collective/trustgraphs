'use client'

import { useQuery } from '@tanstack/react-query'
import { Fragment, useMemo } from 'react'
import type { Hex } from 'viem'

import { useNetwork } from '@/contexts/NetworkContext'
import {
  governanceActionContextFor,
  selectProposalBaselineVersion,
  walkGovernanceActions,
} from '@/lib/actions'
import type { SafeAction, ScoringParamsActionValues } from '@/lib/actions'
import type { RawEdge } from '@/lib/pagerank/types'
import { diffParams, paramsFromJson } from '@/lib/scoring-params'
import { previewScoringChange } from '@/lib/scoring-preview'
import { usePonderQuery } from '@/lib/use-ponder-query'
import { ponderQueries, ponderQueryFns } from '@/queries/ponder'

import { ScoringGraphPreview } from './ScoringGraphPreview'

const instanceIdFor = (id: string, instanceId?: Hex): Hex | undefined =>
  instanceId ?? (/^0x[0-9a-fA-F]{64}$/.test(id) ? (id as Hex) : undefined)

export function ProposalScoringSimulation({
  actions,
  merkleRoot,
  proposalBlock,
}: {
  actions: readonly SafeAction[]
  merkleRoot: string
  proposalBlock: bigint
}) {
  const { network } = useNetwork()
  const update = useMemo(() => {
    const context = governanceActionContextFor(network)
    const matched = walkGovernanceActions(actions, context).find(
      (entry) => entry.definition.key === 'update-scoring-params'
    )
    return matched?.values as ScoringParamsActionValues | undefined
  }, [actions, network])
  const snapshot = network.contracts.merkleSnapshot
  const root = merkleRoot as Hex
  const instanceId = instanceIdFor(network.id, network.instanceId)

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

  const baselineVersion = useMemo(
    () => selectProposalBaselineVersion(history.data?.versions, proposalBlock),
    [history.data?.versions, proposalBlock]
  )
  const baselineParams = useMemo(() => {
    if (!baselineVersion) return undefined
    try {
      return paramsFromJson(baselineVersion.params)
    } catch (error) {
      console.error('Proposal scoring baseline is invalid', error)
      return undefined
    }
  }, [baselineVersion])
  const parameterDiffs = useMemo(
    () =>
      update && baselineParams
        ? diffParams(baselineParams, update.proposed)
        : [],
    [baselineParams, update]
  )

  const simulation = useMemo(() => {
    if (!update || !baselineParams || !inputs.data) return undefined
    const edges: RawEdge[] = inputs.data.inputs.map((input) => ({
      kind: input.kind,
      attester: input.attester,
      recipient: input.recipient,
      uid: input.uid,
      data: input.data,
      blockTimestamp: BigInt(input.blockTimestamp),
    }))
    try {
      const preview = previewScoringChange({
        edges,
        current: baselineParams,
        proposed: update.proposed,
      })
      if (preview.currentRoot.toLowerCase() !== merkleRoot.toLowerCase()) {
        return { mismatch: true as const }
      }
      return { mismatch: false as const, preview }
    } catch (error) {
      console.error('Proposal scoring simulation failed', error)
      return { mismatch: true as const }
    }
  }, [baselineParams, inputs.data, merkleRoot, update])

  if (!update) return null

  const verifiedDiffs = parameterDiffs.length > 0 && (
    <div className="border-l-2 border-foreground/30 bg-surface px-3 py-2">
      <p className="text-xs font-medium text-foreground">
        Settings changed from the proposal baseline
      </p>
      <ul className="mt-2 space-y-1 text-sm text-foreground/80">
        {parameterDiffs.map((diff) => (
          <li key={diff.field}>
            {diff.label}: {diff.before} → {diff.after}
          </li>
        ))}
      </ul>
    </div>
  )

  if (proof.isLoading || inputs.isLoading || history.isLoading) {
    return (
      <Fragment>
        {verifiedDiffs}
        <div
          className="border border-border bg-surface-2 p-4 text-sm text-muted-foreground"
          data-settling="true"
        >
          Recomputing proposal impact from its checkpoint…
        </div>
      </Fragment>
    )
  }

  if (simulation && !simulation.mismatch) {
    return (
      <Fragment>
        {verifiedDiffs}
        <ScoringGraphPreview
          preview={simulation.preview}
          currentSeeds={baselineParams!.trustedSeeds}
          proposedSeeds={update.proposed.trustedSeeds}
        />
      </Fragment>
    )
  }

  const reason = !instanceId
    ? 'This network does not expose a catalog instance ID, so its historical parameter version cannot be verified.'
    : !proof.data
      ? 'The checkpoint that produced this proposal’s voting root is not indexed.'
      : !baselineVersion
        ? 'The proposal’s baseline parameter version is not indexed.'
        : !baselineParams
          ? 'The proposal’s baseline parameter version is invalid.'
          : simulation?.mismatch
            ? 'The recomputed current root does not match the proposal’s voting root.'
            : 'The checkpoint evidence is temporarily unavailable.'

  return (
    <Fragment>
      {verifiedDiffs}
      <div className="border border-border bg-surface-2 p-4 text-sm">
        <p className="font-medium">Impact simulation unavailable</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {reason} The calldata-decoded parameter changes above remain available
          for review; no graph estimate is shown without reproducible evidence.
        </p>
      </div>
    </Fragment>
  )
}
