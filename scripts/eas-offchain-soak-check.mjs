#!/usr/bin/env node

import { readFile } from 'node:fs/promises'

const path = process.argv[2]
if (!path) {
  console.error(
    'usage: scripts/eas-offchain-soak-check.mjs <rollout-evidence.json>'
  )
  process.exit(2)
}

let report
try {
  report = JSON.parse(await readFile(path, 'utf8'))
} catch (error) {
  console.error(`FATAL: cannot read rollout evidence: ${error.message}`)
  process.exit(2)
}
if (!report || typeof report !== 'object' || Array.isArray(report)) {
  console.error(
    'EAS OFFCHAIN SOAK GATE: FAIL (rollout evidence must be a JSON object)'
  )
  process.exit(1)
}

const errors = []
const requireValue = (condition, message) => {
  if (!condition) errors.push(message)
}
const isEvidence = (value) =>
  typeof value === 'string' && value.trim().length > 0
// Rollout records may live in any controlled system, but the ledger must bind the bytes rather
// than merely naming a mutable dashboard or ticket. A content-addressed URI is sufficient; other
// URLs carry an explicit sha256 token (for example `https://…#sha256:<digest>`).
const isImmutableEvidence = (value) => {
  if (!isEvidence(value)) return false
  const reference = value.trim()
  return (
    /^ipfs:\/\/b[a-z2-7]{20,}(?:[/?#].*)?$/i.test(reference) ||
    /^ar:\/\/[A-Za-z0-9_-]{43}(?:[/?#].*)?$/.test(reference) ||
    /(?:^|[#?&\s])sha256[:=][0-9a-f]{64}(?:$|[&\s])/i.test(reference)
  )
}
const isHex32 = (value) => /^0x[0-9a-fA-F]{64}$/.test(value ?? '')
const isTx = isHex32
const isRawSha256Cid = (value) => /^bafkrei[a-z2-7]{52}$/.test(value ?? '')
const isPositiveInteger = (value) => Number.isSafeInteger(value) && value > 0
const isNonNegativeInteger = (value) =>
  Number.isSafeInteger(value) && value >= 0
const isPositiveNumber = (value) => Number.isFinite(value) && value > 0
const isNonNegativeNumber = (value) => Number.isFinite(value) && value >= 0
const timestamp = (value, label) => {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  requireValue(
    Number.isFinite(parsed),
    `${label} must be an ISO-8601 timestamp`
  )
  return parsed
}

requireValue(report.schemaVersion === 3, 'schemaVersion must be 3')
requireValue(isHex32(report.instanceId), 'instanceId must be a bytes32 value')
requireValue(
  report.mainnetEnabled === false,
  'mainnetEnabled must remain false'
)

const componentId = (value) =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)
const topology =
  report.topology &&
  typeof report.topology === 'object' &&
  !Array.isArray(report.topology)
    ? report.topology
    : {}
requireValue(
  topology === report.topology,
  'topology must be a JSON object describing every deployed dependency'
)
const topologyList = (name, minimum, maximum) => {
  const value = Array.isArray(topology[name]) ? topology[name] : []
  requireValue(
    value.length >= minimum && value.length <= maximum,
    `topology.${name} must contain ${minimum}..${maximum} entries`
  )
  const ids = new Set()
  for (const [index, entry] of value.entries()) {
    const label = `topology.${name}[${index}]`
    requireValue(componentId(entry?.id), `${label}.id is invalid`)
    if (componentId(entry?.id)) {
      requireValue(!ids.has(entry.id), `${label}.id duplicates ${entry.id}`)
      ids.add(entry.id)
    }
    requireValue(
      isImmutableEvidence(entry?.evidence),
      `${label}.evidence requires an immutable content digest`
    )
  }
  return value
}
const singleton = (name) => {
  const value =
    topology[name] &&
    typeof topology[name] === 'object' &&
    !Array.isArray(topology[name])
      ? topology[name]
      : {}
  requireValue(value === topology[name], `topology.${name} must be an object`)
  requireValue(componentId(value.id), `topology.${name}.id is invalid`)
  requireValue(
    isImmutableEvidence(value.evidence),
    `topology.${name}.evidence requires an immutable content digest`
  )
  return value
}
const relays = topologyList('relays', 2, 16)
const relayIds = new Set(
  relays.filter((relay) => componentId(relay?.id)).map((relay) => relay.id)
)
const storageTargets = topologyList('storageTargets', 4, 256)
for (const [index, target] of storageTargets.entries())
  requireValue(
    componentId(target?.relayId) && relayIds.has(target.relayId),
    `topology.storageTargets[${index}].relayId does not name a deployed relay`
  )
for (const relay of relays) {
  if (!componentId(relay?.id)) continue
  requireValue(
    storageTargets.filter((target) => target?.relayId === relay.id).length >= 2,
    `topology relay ${relay.id} must have at least two storage targets`
  )
}
const readers = topologyList('readers', 2, 64)
const primaryRpc = singleton('primaryRpc')
const indexer = singleton('indexer')
const prover = singleton('prover')

const started = timestamp(report.soak?.startedAt, 'soak.startedAt')
const ended = timestamp(report.soak?.endedAt, 'soak.endedAt')
if (Number.isFinite(started) && Number.isFinite(ended)) {
  requireValue(ended >= started, 'soak.endedAt must not precede soak.startedAt')
  requireValue(
    ended - started >= 14 * 24 * 60 * 60 * 1000,
    'the observed soak window must be at least 14 complete days'
  )
  requireValue(
    ended <= Date.now() + 5 * 60 * 1000,
    'soak.endedAt cannot be in the future'
  )
}
const requireInSoak = (observed, label) => {
  if (
    Number.isFinite(observed) &&
    Number.isFinite(started) &&
    Number.isFinite(ended)
  )
    requireValue(
      observed >= started && observed <= ended,
      `${label} is outside the soak window`
    )
}

const checkpoints = Array.isArray(report.checkpoints) ? report.checkpoints : []
requireValue(
  checkpoints.length >= 20,
  'at least 20 checkpoint records are required'
)
const checkpointIds = new Set()
const checkpointTransactions = new Set()
const checkpointObservedById = new Map()
let realGroth16 = false
let previousCheckpointId = null
let previousCheckpointObserved = null
for (const [index, checkpoint] of checkpoints.entries()) {
  const label = `checkpoints[${index}]`
  const id = String(checkpoint?.checkpointId ?? '')
  const canonicalId = /^(0|[1-9][0-9]*)$/.test(id)
  requireValue(
    canonicalId,
    `${label}.checkpointId must be a canonical non-negative integer string`
  )
  requireValue(!checkpointIds.has(id), `${label}.checkpointId duplicates ${id}`)
  checkpointIds.add(id)
  if (canonicalId) {
    const numericId = BigInt(id)
    if (previousCheckpointId !== null)
      requireValue(
        numericId > previousCheckpointId,
        `${label}.checkpointId is not strictly increasing`
      )
    previousCheckpointId = numericId
  }
  requireValue(
    typeof checkpoint?.instanceId === 'string' &&
      typeof report.instanceId === 'string' &&
      checkpoint.instanceId.toLowerCase() === report.instanceId.toLowerCase(),
    `${label}.instanceId does not match the rollout instance`
  )
  requireValue(
    checkpoint?.verifiedOnchain === true,
    `${label} is not verified onchain`
  )
  requireValue(
    isTx(checkpoint?.transactionHash),
    `${label}.transactionHash is invalid`
  )
  if (isTx(checkpoint?.transactionHash)) {
    const transaction = checkpoint.transactionHash.toLowerCase()
    requireValue(
      !checkpointTransactions.has(transaction),
      `${label}.transactionHash duplicates an earlier checkpoint`
    )
    checkpointTransactions.add(transaction)
  }
  requireValue(
    isHex32(checkpoint?.outputRoot),
    `${label}.outputRoot is invalid`
  )
  requireValue(
    isRawSha256Cid(checkpoint?.cid),
    `${label}.cid must be a raw sha2-256 CIDv1`
  )
  requireValue(
    isImmutableEvidence(checkpoint?.evidence),
    `${label}.evidence requires an immutable content digest`
  )
  requireValue(
    isPositiveNumber(checkpoint?.proofSeconds),
    `${label}.proofSeconds must be measured`
  )
  requireValue(
    isPositiveInteger(checkpoint?.cycles),
    `${label}.cycles must be measured`
  )
  requireValue(
    isPositiveInteger(checkpoint?.anchorGas),
    `${label}.anchorGas must be measured`
  )
  requireValue(
    isPositiveInteger(checkpoint?.submissionGas),
    `${label}.submissionGas must be measured`
  )
  requireValue(
    isPositiveInteger(checkpoint?.bundleBytes),
    `${label}.bundleBytes must be measured`
  )
  requireValue(
    isNonNegativeInteger(checkpoint?.lane1Leaves),
    `${label}.lane1Leaves must be measured`
  )
  requireValue(
    isPositiveInteger(checkpoint?.lane2Anchors),
    `${label}.lane2Anchors must prove this was a hybrid checkpoint`
  )
  requireValue(
    isPositiveInteger(checkpoint?.lane2Work),
    `${label}.lane2Work must be measured`
  )
  requireValue(
    isPositiveInteger(checkpoint?.workCount),
    `${label}.workCount must be measured`
  )
  if (
    isNonNegativeInteger(checkpoint?.lane1Leaves) &&
    isPositiveInteger(checkpoint?.lane2Work) &&
    isPositiveInteger(checkpoint?.workCount)
  )
    requireValue(
      checkpoint.workCount === checkpoint.lane1Leaves + checkpoint.lane2Work,
      `${label}.workCount must equal lane1Leaves + lane2Work`
    )
  if (
    isPositiveInteger(checkpoint?.lane2Anchors) &&
    isPositiveInteger(checkpoint?.lane2Work)
  )
    requireValue(
      checkpoint.lane2Work >= checkpoint.lane2Anchors,
      `${label}.lane2Work cannot be smaller than lane2Anchors`
    )
  requireValue(
    checkpoint?.proofBackend === 'sp1-network-groth16' ||
      checkpoint?.proofBackend === 'sp1-local-groth16',
    `${label}.proofBackend must identify a Groth16 prover`
  )
  const observed = timestamp(checkpoint?.observedAt, `${label}.observedAt`)
  requireInSoak(observed, label)
  if (canonicalId && Number.isFinite(observed))
    checkpointObservedById.set(id, observed)
  if (Number.isFinite(observed)) {
    if (previousCheckpointObserved !== null)
      requireValue(
        observed >= previousCheckpointObserved,
        `${label}.observedAt is earlier than the preceding ledger record`
      )
    previousCheckpointObserved = observed
  }
  if (checkpoint?.proofBackend === 'sp1-network-groth16') {
    requireValue(
      checkpoint?.lane1Leaves > 0 && checkpoint?.lane2Anchors > 0,
      `${label} real network proof must be mixed-lane`
    )
    if (checkpoint?.lane1Leaves > 0 && checkpoint?.lane2Anchors > 0)
      realGroth16 = true
  }
}
requireValue(
  realGroth16,
  'at least one checkpoint must use the real SP1 network Groth16 backend'
)

const requiredDrills = [
  ...relays
    .filter((entry) => componentId(entry?.id))
    .map((entry) => `relay-loss:${entry.id}`),
  ...storageTargets
    .filter((entry) => componentId(entry?.id))
    .map((entry) => `storage-loss:${entry.id}`),
  ...readers
    .filter((entry) => componentId(entry?.id))
    .map((entry) => `reader-loss:${entry.id}`),
  ...(componentId(primaryRpc.id) ? [`rpc-loss:${primaryRpc.id}`] : []),
  ...(componentId(indexer.id) ? [`indexer-loss:${indexer.id}`] : []),
  ...(componentId(prover.id) ? [`prover-loss:${prover.id}`] : []),
  'all-readers-loss',
  'corrupt-reader-recovery',
  'conflict-recovery',
  'repin-recovery',
  'backup-restore',
  'relayer-key-rotation',
]
for (const name of requiredDrills) {
  const drill = report.drills?.[name]
  requireValue(drill?.status === 'passed', `drill ${name} has not passed`)
  requireValue(
    isImmutableEvidence(drill?.evidence),
    `drill ${name} has no immutable evidence reference`
  )
  const observed = timestamp(drill?.observedAt, `drills.${name}.observedAt`)
  requireInSoak(observed, `drill ${name}`)
  requireValue(
    drill?.alertDelivered === true,
    `drill ${name} has no successful alert-delivery observation`
  )
  requireValue(
    drill?.proofSafetyPreserved === true,
    `drill ${name} did not preserve proof/root safety`
  )
  requireValue(
    drill?.recovered === true,
    `drill ${name} did not complete recovery`
  )
  const recoveryId = String(drill?.postRecoveryCheckpointId ?? '')
  requireValue(
    /^(0|[1-9][0-9]*)$/.test(recoveryId) && checkpointIds.has(recoveryId),
    `drill ${name}.postRecoveryCheckpointId is not in the soak ledger`
  )
  const recoveryObserved = checkpointObservedById.get(recoveryId)
  if (Number.isFinite(observed) && Number.isFinite(recoveryObserved))
    requireValue(
      recoveryObserved > observed,
      `drill ${name} recovery checkpoint must follow the drill`
    )
  if (name.startsWith('relay-loss:'))
    requireValue(
      drill?.alternateRelaySucceeded === true,
      `drill ${name} did not prove alternate-relay success`
    )
  if (name.startsWith('storage-loss:'))
    requireValue(
      drill?.quorumPolicyEnforced === true,
      `drill ${name} did not prove exact-read quorum enforcement`
    )
  if (name.startsWith('reader-loss:'))
    requireValue(
      drill?.remainingReadersExact === true,
      `drill ${name} did not prove exact fallback readers`
    )
  if (name.startsWith('rpc-loss:'))
    requireValue(
      drill?.failoverRpcUsed === true,
      `drill ${name} did not prove finalized RPC failover`
    )
  if (name.startsWith('indexer-loss:'))
    requireValue(
      drill?.replayedFromChain === true,
      `drill ${name} did not prove chain/CID replay`
    )
  if (name.startsWith('prover-loss:'))
    requireValue(
      drill?.byteIdenticalRetry === true,
      `drill ${name} did not prove a byte-identical retry`
    )
}
const specialDrillFields = {
  'all-readers-loss': {
    proofHeld: true,
    proofRequested: false,
    proofSubmitted: false,
  },
  'corrupt-reader-recovery': {
    corruptionRejected: true,
    healthyReaderFallback: true,
    corruptCopyQuarantined: true,
  },
  'conflict-recovery': {
    canonicalHeadReloaded: true,
    unsignedDraftReapplied: true,
    forkAnchorPrevented: true,
  },
  'repin-recovery': {
    cidRecomputed: true,
    byteExactReadback: true,
  },
  'backup-restore': {
    freshRepository: true,
    allCidsRecomputed: true,
    historicalCheckpointReproduced: true,
  },
  'relayer-key-rotation': {
    oldRoleRevoked: true,
    twoDistinctRelayersRetained: true,
  },
}
for (const [name, fields] of Object.entries(specialDrillFields))
  for (const [field, expected] of Object.entries(fields))
    requireValue(
      report.drills?.[name]?.[field] === expected,
      `drill ${name} must record ${field}=${expected}`
    )

const bands = Array.isArray(report.measurementBands)
  ? report.measurementBands
  : []
requireValue(
  bands.length === 3,
  'measurementBands must contain exactly bands 1, 2, and 3'
)
const bandRanges = new Map([
  [1, [1, 1_000]],
  [2, [1_001, 20_000]],
  [3, [20_001, 200_000]],
])
for (const band of [1, 2, 3]) {
  const matching = bands.filter((candidate) => candidate?.band === band)
  requireValue(
    matching.length === 1,
    `measurement band ${band} must appear exactly once`
  )
  const [measurement] = matching
  if (!measurement) continue
  for (const field of ['cycles', 'bundleBytes', 'anchorGas', 'submissionGas'])
    requireValue(
      isPositiveInteger(measurement[field]),
      `measurement band ${band}.${field} must be a positive integer`
    )
  for (const field of ['proofSeconds'])
    requireValue(
      isPositiveNumber(measurement[field]),
      `measurement band ${band}.${field} must be positive`
    )
  requireValue(
    isNonNegativeNumber(measurement.proofCostUsd),
    `measurement band ${band}.proofCostUsd must be measured`
  )
  requireValue(
    isPositiveInteger(measurement.sampleCount),
    `measurement band ${band}.sampleCount must be measured`
  )
  requireValue(
    isPositiveInteger(measurement.workCount) &&
      measurement.workCount >= bandRanges.get(band)[0] &&
      measurement.workCount <= bandRanges.get(band)[1],
    `measurement band ${band}.workCount is outside its published range`
  )
  for (const field of ['failureRateBps', 'capUtilizationBps'])
    requireValue(
      isNonNegativeInteger(measurement[field]) && measurement[field] <= 10_000,
      `measurement band ${band}.${field} must be integer basis points in [0, 10000]`
    )
  requireValue(
    isImmutableEvidence(measurement.evidence),
    `measurement band ${band} lacks evidence`
  )
  const observed = timestamp(
    measurement.observedAt,
    `measurementBands[${band}].observedAt`
  )
  requireInSoak(observed, `measurement band ${band}`)
}

for (const name of [
  'darkDeploy',
  'internalCanary',
  'optInCohort',
  'realGroth16',
])
  requireValue(
    isImmutableEvidence(report.evidence?.[name]),
    `evidence.${name} requires an immutable content digest`
  )

requireValue(
  report.outcomes?.unexplainedRootMismatches === 0,
  'unexplained root mismatches remain'
)
requireValue(
  report.outcomes?.lostAnchoredBundles === 0,
  'an anchored bundle was lost'
)
requireValue(
  report.outcomes?.unresolvedIncidents === 0,
  'unresolved rollout incidents remain'
)

const review = report.securityReview
requireValue(
  isImmutableEvidence(review?.report),
  'independent security review evidence is required'
)
requireValue(
  isEvidence(review?.reviewer),
  'independent reviewer identity is required'
)
requireValue(
  review?.unresolvedCritical === 0,
  'security review has unresolved critical findings'
)
requireValue(
  review?.unresolvedHigh === 0,
  'security review has unresolved high findings'
)
requireValue(
  Array.isArray(review?.mediumFindings),
  'securityReview.mediumFindings must list every medium disposition'
)
for (const [index, finding] of (review?.mediumFindings ?? []).entries()) {
  requireValue(
    finding?.status === 'fixed' || finding?.status === 'accepted-risk',
    `securityReview.mediumFindings[${index}] has no valid disposition`
  )
  requireValue(
    isImmutableEvidence(finding?.evidence),
    `securityReview.mediumFindings[${index}] lacks fix or risk-acceptance evidence`
  )
}

if (errors.length > 0) {
  console.error(
    `EAS OFFCHAIN SOAK GATE: FAIL (${errors.length} issue${errors.length === 1 ? '' : 's'})`
  )
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log(
  `EAS OFFCHAIN SOAK GATE: PASS (${checkpoints.length} checkpoints, ${Math.floor((ended - started) / 86_400_000)} days)`
)
