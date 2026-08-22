//! Server-only authenticated score-program discovery.

import { APIS } from './config'
import {
  type ScoreProgramName,
  type ScoreProgramProvenance,
  parseScoreProgramProvenance,
} from './score-program'

export const getScoreProgram = async (
  snapshot: string,
  expected?: ScoreProgramName
): Promise<ScoreProgramProvenance> => {
  const response = await fetch(`${APIS.ponder}/score-programs/${snapshot}`, {
    next: { revalidate: 10 },
  })
  if (!response.ok) {
    throw new Error(
      `authenticated score-program lookup failed: ${response.status} ${response.statusText}`
    )
  }
  const body = (await response.json()) as { scoreProgram?: unknown }
  return parseScoreProgramProvenance(body.scoreProgram, expected)
}
