import { z } from 'zod'

const word = z.string().regex(/^0x[\da-fA-F]{64}$/)
const text = z.string().max(2 * 1024 * 1024)
const creationOptions = {
  salt: word,
  name: text,
  profile: z.object({
    description: text,
    criteria: text,
    image: text,
    applicationUrl: text,
  }),
  withFund: z.boolean(),
  fundToken: z.enum(['eth', 'other']),
  fundTokenAddress: text,
  withGovernance: z.boolean(),
  prepayEth: text,
  maxPerRootUsd: text,
}

const weightedDraft = z.object({
  ...creationOptions,
  format: z.enum(['csv', 'json']),
  sourceText: text,
  sourceUri: text,
  author: text,
  license: text,
  transform: text,
  cadence: z.enum([
    'monthly',
    'weekly',
    'daily',
    'hourly',
    'tenMinutes',
    'fastest',
  ]),
  instanceId: text,
  binaryInstanceId: text,
})

const compositionDraft = z.object({
  ...creationOptions,
  outputPool: text,
  epochLength: text,
  sources: z
    .array(
      z.object({
        instanceId: word,
        weight: z.string().regex(/^\d{1,78}$/),
        familyId: word,
        maxAgeBlocks: z.string().regex(/^\d{1,78}$/),
      })
    )
    .max(8)
    .refine(
      (sources) =>
        new Set(sources.map((source) => source.instanceId.toLowerCase()))
          .size === sources.length
    ),
})

export type WeightedDraft = z.infer<typeof weightedDraft>
export type CompositionDraft = z.infer<typeof compositionDraft>

/** The schema strips all proofs, pins, simulations, and imported artifacts. */
export function parseWeightedDraft(value: unknown): WeightedDraft | null {
  const result = weightedDraft.safeParse(value)
  return result.success ? result.data : null
}

export function parseCompositionDraft(value: unknown): CompositionDraft | null {
  const result = compositionDraft.safeParse(value)
  return result.success ? result.data : null
}
