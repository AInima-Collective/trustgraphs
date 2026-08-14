import { performance } from 'node:perf_hooks'

import {
  concatHex,
  encodeAbiParameters,
  keccak256,
  type Address,
  type Hex,
} from 'viem'

const SCALE = 1_000_000_000_000_000_000n
const DEGREE = 4
const ITERATIONS = 40

const accountAt = (index: number) =>
  `0x${(index + 1).toString(16).padStart(40, '0')}` as Address

const hashPair = (left: Hex, right: Hex) =>
  keccak256(left < right ? concatHex([left, right]) : concatHex([right, left]))

const preview = (count: number) => {
  const base = SCALE / BigInt(count)
  const remainder = SCALE % BigInt(count)
  const weights = Array.from(
    { length: count },
    (_, index) => base + (BigInt(index) < remainder ? 1n : 0n)
  )
  let level = weights.map((weight, index) =>
    keccak256(
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }],
        [accountAt(index), weight]
      )
    )
  )
  while (level.length > 1) {
    const next: Hex[] = []
    for (let index = 0; index < level.length; index += 2) {
      next.push(
        index + 1 === level.length
          ? level[index]
          : hashPair(level[index], level[index + 1])
      )
    }
    level = next
  }

  const targets = new Uint32Array(count * DEGREE)
  for (let from = 0; from < count; from += 1) {
    for (let offset = 1; offset <= DEGREE; offset += 1) {
      targets[from * DEGREE + offset - 1] = (from + offset) % count
    }
  }
  let rank = new Float64Array(count).fill(1 / count)
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const next = new Float64Array(count).fill(0.15 / count)
    for (let from = 0; from < count; from += 1) {
      const share = (rank[from] * 0.85) / DEGREE
      for (let edge = 0; edge < DEGREE; edge += 1) {
        next[targets[from * DEGREE + edge]] += share
      }
    }
    rank = next
  }

  // Keep all work observable to V8 without including console time in the measurement.
  return `${level[0]}:${rank[0]}`
}

const median = (values: number[]) =>
  [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]

console.log(
  'count,degree,iterations,median_preview_ms,compact_manifest_bytes,typed_working_set_bytes'
)
for (const count of [128, 512, 1024, 2048]) {
  preview(count)
  const samples: number[] = []
  for (let run = 0; run < 7; run += 1) {
    const started = performance.now()
    preview(count)
    samples.push(performance.now() - started)
  }
  // Two rank vectors + targets + normalized u64s + 32-byte Merkle leaves + compact manifest.
  const workingSet = count * (16 + DEGREE * 4 + 8 + 32 + 28)
  console.log(
    `${count},${DEGREE},${ITERATIONS},${median(samples).toFixed(3)},${18 + count * 28},${workingSet}`
  )
}
