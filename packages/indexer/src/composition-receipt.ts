import { type Hex, decodeEventLog, parseAbi } from 'viem'

export const compositionProofSubmittedAbi = parseAbi([
  'event MerkleProofSubmitted(uint256 indexed checkpointId,bytes32 indexed root,address indexed prover,address recipient)',
])

const sameHex = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase()

export type CompositionReceiptLog = {
  address: string
  data: Hex
  topics: [] | [signature: Hex, ...args: Hex[]]
}

/** Resolve the checkpoint from the proof event in this transaction, never from block-end state. */
export const compositionCheckpointFromReceipt = (
  snapshot: string,
  root: string,
  logs: readonly CompositionReceiptLog[]
) => {
  const submissions = logs.flatMap((log) => {
    if (!sameHex(log.address, snapshot)) return []
    try {
      const decoded = decodeEventLog({
        abi: compositionProofSubmittedAbi,
        eventName: 'MerkleProofSubmitted',
        data: log.data,
        topics: log.topics,
      }) as any
      return sameHex(decoded.args.root, root) ? [decoded.args] : []
    } catch {
      return []
    }
  })
  if (submissions.length !== 1)
    throw new Error(
      'composition root transaction has no unique proof submission'
    )
  return submissions[0]!.checkpointId as bigint
}

export const compositionCheckpointForEvent = async (
  event: any,
  context: any
) => {
  const receipt = await context.client.getTransactionReceipt({
    hash: event.transaction.hash,
  })
  return compositionCheckpointFromReceipt(
    event.log.address,
    event.args.root,
    receipt.logs
  )
}
