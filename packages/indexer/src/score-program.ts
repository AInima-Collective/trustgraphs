/**
 * Loader-normalized bridge to the browser's canonical score-program registry. Ponder bundles the
 * frontend module as ESM, while standalone node:test/tsx crosses a CommonJS package boundary.
 */
import * as scoreProgramNs from '../../frontend/lib/score-program'
import type {
  ScoreApi,
  ScoreProgramDefinition,
  ScoreProgramName,
  ScoreProgramProvenance,
} from '../../frontend/lib/score-program'

const scoreProgram = ((scoreProgramNs as any).default ??
  scoreProgramNs) as typeof scoreProgramNs

export const SCORE_PROGRAM_IDS = scoreProgram.SCORE_PROGRAM_IDS
export const SCORE_OUTPUT_DOMAIN_IDS = scoreProgram.SCORE_OUTPUT_DOMAIN_IDS
export const SCORE_PROGRAMS = scoreProgram.SCORE_PROGRAMS
export const SCORE_KEY_DOMAINS = scoreProgram.SCORE_KEY_DOMAINS
export const scoreProgramById = scoreProgram.scoreProgramById
export const requireScoreProgram = scoreProgram.requireScoreProgram
export const validateScoreBlob = scoreProgram.validateScoreBlob
export const requireScoreApi = scoreProgram.requireScoreApi
export const requireScoreKeyDomain = scoreProgram.requireScoreKeyDomain
export const parseScoreKeyDomainProvenance =
  scoreProgram.parseScoreKeyDomainProvenance
export const requireScoreProgramSourceKind =
  scoreProgram.requireScoreProgramSourceKind
export const parseScoreProgramProvenance =
  scoreProgram.parseScoreProgramProvenance

export type {
  ScoreApi,
  ScoreProgramDefinition,
  ScoreProgramName,
  ScoreProgramProvenance,
}
