import {
  SCORE_OUTPUT_DOMAIN_IDS,
  type ScoreProgramDefinition,
} from './score-program'

export type ScoreBackfillFamily =
  | 'address-merkle'
  | 'contributions'
  | 'hypercerts'

/** Pure, audited table plan shared by the repair CLI and tests. */
export const scoreBackfillFamilies = (
  program: ScoreProgramDefinition
): readonly ScoreBackfillFamily[] => {
  switch (program.ingestion) {
    case 'address-merkle':
      return ['address-merkle']
    case 'contributions':
      return ['address-merkle', 'contributions']
    case 'hypercerts':
      return ['hypercerts']
    case 'not-enabled':
      throw new Error(
        `refusing to backfill ${program.name}: its production ingestion is not enabled`
      )
  }
}

/** Exact row patches shared by live restart repair and the audited one-shot backfill. */
export const scoreRowDiscriminators = (program: ScoreProgramDefinition) => ({
  primary: {
    programId: program.programId,
    outputDomain: program.outputDomain,
  },
  claim:
    program.ingestion === 'contributions'
      ? {
          programId: program.programId,
          outputDomain: SCORE_OUTPUT_DOMAIN_IDS['contributions-claim-v1'],
        }
      : null,
})

/** A replay may skip the untrusted blob fetch only when every program-owned root surface exists. */
export const canRepairScoreRowsOnRestart = (
  program: ScoreProgramDefinition,
  state: { metadata: boolean; entries: boolean; contributionRound: boolean }
) =>
  state.metadata &&
  state.entries &&
  (program.ingestion !== 'contributions' || state.contributionRound)
