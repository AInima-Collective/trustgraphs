import type { Hex } from 'viem'

import type { Network } from '../types'
import type { WeightedApiEntry, WeightedApiInstanceDetail } from './api'
import { SCALE } from './core'

const VOUCH_SCHEMA = 'string comment,uint256 confidence'

/** Present one isolated weighted-prior catalog row through the shared vouch-network overview. */
export const weightedInstanceToNetwork = (
  instance: WeightedApiInstanceDetail,
  entries: readonly WeightedApiEntry[] = []
): Network => ({
  program: 'trust-graph-weighted',
  id: instance.id,
  instanceId: instance.id,
  admin: instance.admin,
  epochLength: instance.epochLength,
  paramsHash: instance.currentParamsHash,
  createdTimestamp: instance.createdTimestamp,
  name: instance.name,
  about:
    'Trust scores start from this network’s weighted prior and evolve with member vouches.',
  criteria:
    'Vouch only for people you actually know and trust. Prior membership does not replace a vouch.',
  contracts: {
    merkleSnapshot: instance.snapshot,
    easIndexerResolver: instance.resolver,
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
  schemas: [
    {
      uid: instance.schemaUid,
      key: 'vouching',
      name: 'Vouch',
      description: 'Weighted endorsement',
      resolver: instance.resolver,
      revocable: true,
      schema: VOUCH_SCHEMA,
      fields: [
        { name: 'comment', type: 'string' },
        { name: 'confidence', type: 'uint256' },
      ],
    },
  ],
  // The shared overview consumes this subset only for display. Its binary-seed what-if simulator
  // is hidden for weighted networks; exact weighted previews remain in the prior workspace.
  pagerank: {
    enabled: true,
    pointsPool: SCALE.toString(),
    trustShare: 0,
    trustDecay: 0,
    minWeight: Number(instance.params.minWeight),
    maxWeight: Number(instance.params.maxWeight),
    trustedSeeds: entries.map((entry) => entry.account as Hex),
  },
  safeZodiacSignerSync: {
    enabled: false,
    topNSigners: 0,
    minThreshold: 0,
    targetThreshold: 0,
  },
  validatedThreshold: 0,
})
