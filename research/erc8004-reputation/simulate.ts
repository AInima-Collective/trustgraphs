import { readFileSync } from 'node:fs'

import {
  type ExperimentInput,
  type ExperimentPolicy,
  runExperiment,
} from './reference'

const read = <T>(name: string) =>
  JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8')) as T

const result = runExperiment(
  read<ExperimentPolicy>('policy.json'),
  read<ExperimentInput>('input.json')
)

console.log(
  JSON.stringify(
    {
      experimentId: result.experimentId,
      policySha256: result.policySha256,
      inputSha256: result.inputSha256,
      resultSha256: result.resultSha256,
      metrics: result.metrics,
      direct: result.direct,
      propagationTargets: result.propagation.targets,
      comparison: result.comparison,
      leaveOneOut: result.leaveOneOut.map((run) => ({
        omittedReviewerAgentKey: run.omittedReviewerAgentKey,
        targetsLosingAllDirectEvidence: run.targetsLosingAllDirectEvidence,
        maxDirectScoreDeltaMicros: run.maxDirectScoreDeltaMicros,
        maxPropagationTargetMassDelta: run.maxPropagationTargetMassDelta,
      })),
      recommendation: result.recommendation,
    },
    null,
    2
  )
)
