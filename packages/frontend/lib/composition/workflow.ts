import { type Address, type Hex, encodeAbiParameters, keccak256 } from 'viem'

import {
  type CompositionPreview,
  type LandedCompositionCommitments,
  comparePreviewToLanded,
} from './core'

export type CompositionPreviewAnchor = {
  fingerprint: Hex
  policyManifest: Hex
  policyManifestSha256: Hex
  captureManifest: Hex
  captureManifestSha256: Hex
  outputBlobSha256: Hex
  outputRoot: Hex
  outputCid: string
}

export const anchorCompositionPreview = (
  preview: CompositionPreview
): CompositionPreviewAnchor => ({
  fingerprint: keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
      ],
      [
        preview.policyManifestSha256,
        preview.captureManifestSha256,
        preview.outputBlobSha256,
        preview.outputRoot,
      ]
    )
  ),
  policyManifest: preview.policyManifest,
  policyManifestSha256: preview.policyManifestSha256,
  captureManifest: preview.captureManifest,
  captureManifestSha256: preview.captureManifestSha256,
  outputBlobSha256: preview.outputBlobSha256,
  outputRoot: preview.outputRoot,
  outputCid: preview.outputCid,
})

export type CompositionWorkflowState = {
  revision: number
  phase: 'editing' | 'previewed' | 'simulated' | 'submitted' | 'confirmed'
  anchor: CompositionPreviewAnchor | null
  simulatedPayloadHash: Hex | null
  txHash: Hex | null
  canonicalBlockHash: Hex | null
  notice: string | null
}

export const initialCompositionWorkflow = (): CompositionWorkflowState => ({
  revision: 0,
  phase: 'editing',
  anchor: null,
  simulatedPayloadHash: null,
  txHash: null,
  canonicalBlockHash: null,
  notice: null,
})

export type CompositionWorkflowAction =
  | { type: 'edit'; reason: string }
  | { type: 'preview'; preview: CompositionPreview }
  | { type: 'simulate'; payload: Hex; preview: CompositionPreview }
  | { type: 'wallet-rejected' }
  | { type: 'submit'; txHash: Hex; payload: Hex }
  | { type: 'confirm'; blockHash: Hex }
  | { type: 'reorg' }

/**
 * Deterministic signing state. Any source/weight/capture edit discards simulation; wallet refusal
 * deliberately does not. A reorg returns a submitted receipt to the last byte-reviewed preview.
 */
export const reduceCompositionWorkflow = (
  state: CompositionWorkflowState,
  action: CompositionWorkflowAction
): CompositionWorkflowState => {
  if (action.type === 'edit') {
    return {
      ...initialCompositionWorkflow(),
      revision: state.revision + 1,
      notice: `Preview invalidated: ${action.reason}`,
    }
  }
  if (action.type === 'preview') {
    return {
      ...state,
      phase: 'previewed',
      anchor: anchorCompositionPreview(action.preview),
      simulatedPayloadHash: null,
      txHash: null,
      canonicalBlockHash: null,
      notice: null,
    }
  }
  if (action.type === 'simulate') {
    const anchor = anchorCompositionPreview(action.preview)
    if (state.anchor?.fingerprint !== anchor.fingerprint) {
      throw new Error(
        'Preview changed before simulation; review the new exact bytes.'
      )
    }
    return {
      ...state,
      phase: 'simulated',
      simulatedPayloadHash: keccak256(action.payload),
      notice: null,
    }
  }
  if (action.type === 'wallet-rejected') {
    return {
      ...state,
      notice:
        'Wallet request rejected. The reviewed simulation is still current.',
    }
  }
  if (action.type === 'submit') {
    if (
      state.phase !== 'simulated' ||
      state.simulatedPayloadHash !== keccak256(action.payload)
    ) {
      throw new Error(
        'Transaction payload differs from the reviewed simulation.'
      )
    }
    return { ...state, phase: 'submitted', txHash: action.txHash, notice: null }
  }
  if (action.type === 'confirm') {
    if (state.phase !== 'submitted') {
      throw new Error(
        'Cannot confirm a composition transaction that was not submitted.'
      )
    }
    return {
      ...state,
      phase: 'confirmed',
      canonicalBlockHash: action.blockHash,
      notice: null,
    }
  }
  if (!state.anchor) return initialCompositionWorkflow()
  return {
    ...state,
    phase: 'previewed',
    simulatedPayloadHash: null,
    txHash: null,
    canonicalBlockHash: null,
    notice: 'Receipt was removed by a reorg. Re-simulate before retrying.',
  }
}

export type CompositionDeploymentAvailability = {
  mode: 'ready' | 'read-only' | 'offline'
  canPreview: boolean
  canSign: boolean
  message: string
}

export const compositionDeploymentAvailability = ({
  apiAvailable,
  factory,
}: {
  apiAvailable: boolean
  factory?: Address | null
}): CompositionDeploymentAvailability => {
  if (!apiAvailable) {
    return {
      mode: 'offline',
      canPreview: false,
      canSign: false,
      message:
        'Composition indexing is not deployed yet. Existing network creation remains unchanged.',
    }
  }
  if (!factory) {
    return {
      mode: 'read-only',
      canPreview: true,
      canSign: false,
      message:
        'Composition preview and provenance are available, but this chain has no configured composition factory.',
    }
  }
  return {
    mode: 'ready',
    canPreview: true,
    canSign: true,
    message:
      'Composition preview, creation, and governed rotation are available.',
  }
}

export type CompositionHistoryEvent = {
  id: string
  kind: 'create' | 'propose' | 'cancel' | 'activate' | 'checkpoint'
  version: bigint
  blockNumber: bigint
  blockHash: Hex
  transactionIndex: number
  logIndex: number
}

export type CompositionPolicyHistory = {
  versions: Map<bigint, 'pending' | 'active' | 'superseded' | 'cancelled'>
  checkpoints: Array<{ id: string; version: bigint }>
}

/** Replays only events whose block hash is still canonical; suitable for refresh/reorg fixtures. */
export const replayCompositionHistory = (
  events: CompositionHistoryEvent[],
  canonicalBlocks: ReadonlyMap<bigint, Hex>
): CompositionPolicyHistory => {
  const versions = new Map<
    bigint,
    'pending' | 'active' | 'superseded' | 'cancelled'
  >()
  const checkpoints: Array<{ id: string; version: bigint }> = []
  const canonical = events
    .filter(
      (event) => canonicalBlocks.get(event.blockNumber) === event.blockHash
    )
    .sort((left, right) => {
      if (left.blockNumber !== right.blockNumber) {
        return left.blockNumber < right.blockNumber ? -1 : 1
      }
      if (left.transactionIndex !== right.transactionIndex) {
        return left.transactionIndex - right.transactionIndex
      }
      return left.logIndex - right.logIndex
    })
  for (const event of canonical) {
    if (event.kind === 'create') versions.set(event.version, 'active')
    if (event.kind === 'propose') versions.set(event.version, 'pending')
    if (event.kind === 'cancel') versions.set(event.version, 'cancelled')
    if (event.kind === 'activate') {
      for (const [version, status] of versions) {
        if (status === 'active') versions.set(version, 'superseded')
      }
      versions.set(event.version, 'active')
    }
    if (event.kind === 'checkpoint') {
      checkpoints.push({ id: event.id, version: event.version })
    }
  }
  return { versions, checkpoints }
}

export const verifyLandedComposition = (
  preview: CompositionPreview,
  landed: LandedCompositionCommitments
) => {
  const comparison = comparePreviewToLanded(preview, landed)
  const mismatches = Object.entries(comparison.fields)
    .filter(([, identical]) => !identical)
    .map(([field]) => field)
  return {
    ...comparison,
    mismatches,
    message: comparison.byteIdentical
      ? 'Preview and landed policy, capture, blob, and output commitments are byte-identical.'
      : `Landed commitments differ: ${mismatches.join(', ')}.`,
  }
}
