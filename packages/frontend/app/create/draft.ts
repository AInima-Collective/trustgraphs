import { z } from 'zod'

import type { WizardData } from './model'

const address = z.string().regex(/^0x[\da-fA-F]{40}$/)
const wizardDraft = z.object({
  step: z.number().int().min(0).max(4),
  salt: z.string().regex(/^0x[\da-fA-F]{64}$/),
  data: z.object({
    name: z.string(),
    description: z.string(),
    criteria: z.string(),
    image: z.string(),
    applicationUrl: z.string(),
    seeds: z.array(address),
    seedNames: z.record(z.string()),
    tuning: z.object({
      vouchWeightPct: z.number().finite(),
      headStartPct: z.number().finite(),
      headStartKeptPct: z.number().finite(),
      totalPoints: z.number().finite(),
      cadence: z.enum([
        'monthly',
        'weekly',
        'daily',
        'hourly',
        'tenMinutes',
        'fastest',
      ]),
    }),
    withFund: z.boolean(),
    fundToken: z.enum(['eth', 'other']),
    fundTokenAddress: z.string(),
    prepayEth: z.string(),
    maxPerRootUsd: z.string(),
    withSignerSync: z.boolean(),
    withOffchainVouches: z.boolean(),
    offchainMaxTotalInputs: z.number().finite(),
    signerTopN: z.number().finite(),
    signerMinThreshold: z.number().finite(),
    signerTargetThresholdPct: z.number().finite(),
    subnetworkTier: z.enum(['admin', 'guardian', 'label']),
  }),
})

export type CreationDraft = {
  step: number
  salt: `0x${string}`
  data: WizardData
}
export function parseCreationDraft(value: unknown): CreationDraft | null {
  const result = wizardDraft.safeParse(value)
  return result.success ? (result.data as CreationDraft) : null
}
