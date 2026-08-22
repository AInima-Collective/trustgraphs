import { readFileSync, writeFileSync } from 'node:fs'

import {
  canonicalExperimentInput,
  canonicalExperimentPolicy,
  type ExperimentInput,
  type ExperimentPolicy,
  runExperiment,
} from './reference'

const directory = new URL('./', import.meta.url)
const read = <T>(name: string) =>
  JSON.parse(readFileSync(new URL(name, directory), 'utf8')) as T

const policy = read<ExperimentPolicy>('policy.json')
const input = read<ExperimentInput>('input.json')
const result = runExperiment(policy, input)

writeFileSync(
  new URL('canonical-policy.json', directory),
  `${canonicalExperimentPolicy(policy)}\n`
)
writeFileSync(
  new URL('canonical-input.json', directory),
  `${canonicalExperimentInput(input)}\n`
)
writeFileSync(
  new URL('golden.json', directory),
  `${JSON.stringify(result, null, 2)}\n`
)

const suffix = (agentKey: string) => `Agent #${agentKey.split(':').at(-1)}`
const presentation = {
  generatedFrom: {
    policySha256: result.policySha256,
    inputSha256: result.inputSha256,
    resultSha256: result.resultSha256,
  },
  policy: {
    experimentId: policy.experimentId,
    registry: policy.registry,
    tag: policy.feedback.tag,
    unit: policy.feedback.unit,
    valueDecimals: policy.feedback.valueDecimals,
    interpretation: policy.feedback.interpretation,
    reviewerSourceId: policy.reviewerTrust.sourceId,
    reviewerEpoch: policy.reviewerTrust.epoch,
    reviewerRoot: policy.reviewerTrust.root,
    pairRule: policy.pairReconciliation.rule,
    responseRule: policy.pairReconciliation.responses,
    revocationRule: policy.pairReconciliation.revocations,
    outputIdentityDomain: policy.outputIdentityDomain,
  },
  metrics: result.metrics,
  direct: result.direct.map((target) => ({
    ...target,
    label: suffix(target.targetAgentKey),
  })),
  propagation: result.propagation.targets.map((target) => ({
    ...target,
    label: suffix(target.agentKey),
  })),
  edges: result.includedPairs
    .filter((pair) => BigInt(pair.value) > 0n)
    .map((pair) => ({
      recordId: pair.recordId,
      from: pair.reviewerAgentKey,
      fromLabel: suffix(pair.reviewerAgentKey),
      to: pair.targetAgentKey,
      toLabel: suffix(pair.targetAgentKey),
      value: pair.value,
      reviewerWeightBps: pair.reviewerWeightBps,
    })),
  comparison: result.comparison,
  sensitivity: result.leaveOneOut.map((run) => ({
    omittedReviewerAgentKey: run.omittedReviewerAgentKey,
    omittedReviewerLabel: suffix(run.omittedReviewerAgentKey),
    targetsLosingAllDirectEvidence: run.targetsLosingAllDirectEvidence,
    maxDirectScoreDeltaMicros: run.maxDirectScoreDeltaMicros,
    maxPropagationTargetMassDelta: run.maxPropagationTargetMassDelta,
  })),
  recommendation: result.recommendation,
}

writeFileSync(
  new URL('../../packages/frontend/lib/erc8004-reputation-experiment.json', directory),
  `${JSON.stringify(presentation, null, 2)}\n`
)

console.log(
  JSON.stringify(
    {
      policySha256: result.policySha256,
      inputSha256: result.inputSha256,
      resultSha256: result.resultSha256,
      includedRecords: result.metrics.includedRecords,
      pairCoverageMicros: result.metrics.coverage.pairCoverageMicros,
      recommendation: result.recommendation.decision,
    },
    null,
    2
  )
)
