import { zeroAddress } from 'viem'

import type { Network } from '../types'
import type { CompositionInstance } from './api'

const text = (value: string | undefined) => value?.trim() ?? ''

/**
 * Presentation adapter for components shared by every address-keyed score network. Composition
 * controls still use their dedicated contracts; this shape only supplies common identity,
 * snapshot, rewards, and navigation data.
 */
export const compositionAsNetwork = (
  instance: CompositionInstance
): Network => ({
  program: 'trust-compose',
  id: instance.id,
  instanceId: instance.id,
  admin: instance.admin,
  epochLength: instance.epochLength,
  createdTimestamp: instance.createdTimestamp,
  name: text(instance.metadata?.name) || instance.name,
  ...(text(instance.metadata?.image)
    ? { image: text(instance.metadata?.image) }
    : {}),
  metadataURI: instance.metadataURI,
  metadataURIHash: instance.metadataURIHash,
  metadataRevision: instance.metadataRevision,
  metadataStatus: instance.metadataStatus,
  ...(instance.metadata ? { profile: instance.metadata } : {}),
  about: text(instance.metadata?.description),
  criteria: text(instance.metadata?.criteria),
  applicationUrl: text(instance.metadata?.applicationUrl) || undefined,
  ...(text(instance.metadata?.applicationUrl)
    ? {
        link: {
          prefix: 'Interested?',
          label: 'Ask to join',
          href: text(instance.metadata?.applicationUrl),
        },
      }
    : {}),
  contracts: {
    merkleSnapshot: instance.snapshot,
    // Compositions have no EAS vouch resolver. The accumulator is retained here as the closest
    // common provenance field; composition screens never invoke the vouching workflow.
    easIndexerResolver: instance.accumulator || zeroAddress,
    ...(instance.governance
      ? {
          merkleGovModule: instance.governance.module,
          safe: { proxy: instance.governance.safe },
        }
      : {}),
    ...(instance.distributor
      ? { merkleFundDistributor: instance.distributor }
      : {}),
  },
  schemas: [],
  pagerank: {
    enabled: false,
    pointsPool:
      typeof instance.params.outputPool === 'string'
        ? instance.params.outputPool
        : '0',
    trustShare: 0,
    trustDecay: 0,
    minWeight: 0,
    maxWeight: 0,
    trustedSeeds: [],
  },
  safeZodiacSignerSync: {
    enabled: false,
    topNSigners: 0,
    minThreshold: 0,
    targetThreshold: 0,
  },
  validatedThreshold: 0,
})
