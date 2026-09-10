'use client'

import { useQuery } from '@tanstack/react-query'
import { Fragment, useMemo } from 'react'
import type { Hex } from 'viem'

import { useNetwork } from '@/contexts/NetworkContext'
import {
  governanceActionContextFor,
  normalizeSafeActions,
  reconstructProposalBaseline,
  selectProposalProof,
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
  const normalizedActions = useMemo(
    () => normalizeSafeActions(actions),
    [actions]
  )
  const update = useMemo(() => {
    if (!normalizedActions.ok) return undefined
    const context = governanceActionContextFor(network)
    const matched = walkGovernanceActions(
      normalizedActions.actions,
      context
    ).find((entry) => entry.definition.key === 'update-scoring-params')
    return matched?.values as ScoringParamsActionValues | undefined
  }, [network, normalizedActions])
  const snapshot = network.contracts.merkleSnapshot
  const root = merkleRoot as Hex
  const instanceId = instanceIdFor(network.id, network.instanceId)
  const canOrderEvidence = proposalBlock > 0n

  const proof = usePonderQuery({
    queryFn: ponderQueryFns.getProofSubmissionsBefore({
      snapshot,
      root,
      proposalBlock,
    }),
    enabled: !!update && !!merkleRoot && canOrderEvidence,
  })
  const proofSelection = selectProposalProof(proof.data)
  const uniqueProof =
    proofSelection.status === 'verified' ? proofSelection.proof : undefined
  const checkpointId = uniqueProof?.checkpointId.toString() ?? ''
  const inputs = useQuery({
    ...ponderQueries.checkpointInputs(snapshot, checkpointId),
    enabled: !!update && !!checkpointId,
  })
  const history = useQuery({
    ...ponderQueries.parameterHistory(instanceId ?? ''),
    enabled: !!update && !!instanceId && canOrderEvidence,
  })

  const reconstruction = useMemo(() => {
    if (!update || !uniqueProof || !inputs.data || !history.data)
      return undefined
    return reconstructProposalBaseline({
      versions: history.data.versions,
      proposalBlock,
      checkpointId: uniqueProof.checkpointId,
      expectedRoot: merkleRoot,
      reconstruct: (version) => {
        const baselineParams = paramsFromJson(version.params)
        const edges: RawEdge[] = inputs.data.inputs.map((input) => ({
          kind: input.kind,
          attester: input.attester,
          recipient: input.recipient,
          uid: input.uid,
          data: input.data,
          blockTimestamp: BigInt(input.blockTimestamp),
        }))
        const preview = previewScoringChange({
          edges,
          current: baselineParams,
          proposed: update.proposed,
        })
        return {
          root: preview.currentRoot,
          result: { baselineParams, preview },
        }
      },
    })
  }, [
    history.data,
    inputs.data,
    merkleRoot,
    proposalBlock,
    uniqueProof,
    update,
  ])

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

  if (reconstruction?.status === 'verified') {
    const { baselineParams, preview } = reconstruction.result
    const parameterDiffs = diffParams(baselineParams, update.proposed)
    return (
      <Fragment>
        {parameterDiffs.length > 0 && (
          <div className="border-l-2 border-foreground/30 bg-surface px-3 py-2">
            <p className="text-xs font-medium text-foreground">
              Settings changed from the root-verified proposal baseline
            </p>
            <ul className="mt-2 space-y-1 text-sm text-foreground/80">
              {parameterDiffs.map((diff) => (
                <li key={diff.field}>
                  {diff.label}: {diff.before} → {diff.after}
                </li>
              ))}
            </ul>
          </div>
        )}
        <ScoringGraphPreview
          preview={preview}
          currentSeeds={baselineParams.trustedSeeds}
          proposedSeeds={update.proposed.trustedSeeds}
        />
      </Fragment>
    )
  }

  const reason = !canOrderEvidence
    ? 'This proposal was recovered without its original creation block, so parameter history cannot be ordered safely.'
    : !instanceId
      ? 'This network does not expose a catalog instance ID, so its historical parameter version cannot be verified.'
      : proof.data?.length === 0
        ? 'No checkpoint carrying this root is indexed strictly before the proposal block.'
        : proofSelection.status === 'unavailable' &&
            proofSelection.reason === 'same-block-proof'
          ? 'More than one checkpoint carrying this root landed in the newest eligible block, so their input order is ambiguous.'
          : reconstruction?.reason === 'same-block-order'
            ? 'A candidate parameter version was published in the proposal block and cannot be ordered safely.'
            : reconstruction?.reason === 'ambiguous-root'
              ? 'More than one historical parameter version reconstructs this root.'
              : reconstruction?.reason === 'root-mismatch'
                ? 'No eligible historical parameter version reconstructs the proposal’s voting root.'
                : reconstruction?.reason === 'invalid-history' ||
                    reconstruction?.reason === 'invalid-reconstruction'
                  ? 'The indexed parameter or checkpoint evidence is invalid.'
                  : reconstruction?.reason === 'no-candidates'
                    ? 'No checkpoint-bound parameter version predates this proposal.'
                    : 'The checkpoint evidence is temporarily unavailable.'

  return (
    <div className="border border-border bg-surface-2 p-4 text-sm">
      <p className="font-medium">Impact simulation unavailable</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {reason} The calldata-decoded proposed settings above remain available
        for review; no baseline differences or graph estimate are shown without
        reproducible evidence.
      </p>
    </div>
  )
}
