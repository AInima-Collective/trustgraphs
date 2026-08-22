import assert from 'node:assert/strict'
import test from 'node:test'

import {
  type Address,
  type Hex,
  encodeAbiParameters,
  encodeEventTopics,
} from 'viem'

import {
  compositionCheckpointFromReceipt,
  compositionProofSubmittedAbi,
} from './composition-receipt'

const snapshot = `0x${'11'.repeat(20)}` as Address
const prover = `0x${'22'.repeat(20)}` as Address
const recipient = `0x${'33'.repeat(20)}` as Address
const rootA = `0x${'aa'.repeat(32)}` as Hex
const rootB = `0x${'bb'.repeat(32)}` as Hex

const proofLog = (checkpointId: bigint, root: Hex, address = snapshot) => ({
  address,
  topics: encodeEventTopics({
    abi: compositionProofSubmittedAbi,
    eventName: 'MerkleProofSubmitted',
    args: { checkpointId, root, prover },
  }) as [Hex, ...Hex[]],
  data: encodeAbiParameters([{ type: 'address' }], [recipient]),
})

test('composition checkpoint recovery is transaction-scoped, not block-end state', () => {
  const logs = [proofLog(7n, rootA), proofLog(8n, rootB)]
  assert.equal(compositionCheckpointFromReceipt(snapshot, rootA, logs), 7n)
  assert.equal(compositionCheckpointFromReceipt(snapshot, rootB, logs), 8n)
})

test('composition checkpoint recovery refuses ambiguous repeated-root submissions', () => {
  assert.throws(
    () =>
      compositionCheckpointFromReceipt(snapshot, rootA, [
        proofLog(7n, rootA),
        proofLog(8n, rootA),
      ]),
    /no unique proof submission/
  )
})
