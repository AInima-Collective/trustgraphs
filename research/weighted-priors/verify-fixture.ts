import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import {
  concatHex,
  encodeAbiParameters,
  keccak256,
  type Address,
  type Hex,
} from 'viem'

type Entry = { account: Address; weight: string }
type Fixture = {
  chainId: number
  scale: string
  raw: Entry[]
  normalized: Entry[]
  leaves: Hex[]
  priorRoot: Hex
  manifest: Hex
  manifestSha256: Hex
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixture.json', import.meta.url), 'utf8')
) as Fixture
const scale = BigInt(fixture.scale)

const canonicalUnits = (value: string) => {
  const match = /^(0|[1-9][0-9]{0,19})(?:\.([0-9]{0,17}[1-9]))?$/.exec(value)
  if (!match) throw new Error(`non-canonical decimal: ${value}`)
  const fraction = match[2] ?? ''
  const parsed =
    BigInt(match[1]) * scale +
    BigInt(fraction || '0') * 10n ** BigInt(18 - fraction.length)
  if (parsed === 0n) throw new Error('weight must be positive')
  return parsed
}

const normalize = (raw: Entry[]) => {
  const parsed = raw
    .map((entry) => ({ ...entry, raw: canonicalUnits(entry.weight) }))
    .sort((left, right) => left.account.localeCompare(right.account))
  if (new Set(parsed.map((entry) => entry.account)).size !== parsed.length) {
    throw new Error('duplicate account')
  }
  const total = parsed.reduce((sum, entry) => sum + entry.raw, 0n)
  const apportioned = parsed.map((entry) => ({
    account: entry.account,
    weight: (entry.raw * scale) / total,
    remainder: (entry.raw * scale) % total,
  }))
  let missing =
    scale - apportioned.reduce((sum, entry) => sum + entry.weight, 0n)
  const order = [...apportioned].sort((left, right) => {
    if (left.remainder !== right.remainder) {
      return left.remainder > right.remainder ? -1 : 1
    }
    return left.account.localeCompare(right.account)
  })
  for (const entry of order) {
    if (missing === 0n) break
    entry.weight += 1n
    missing -= 1n
  }
  return apportioned.map(({ account, weight }) => ({
    account,
    weight: weight.toString(),
  }))
}

const normalized = normalize(fixture.raw)
const leaves = normalized.map((entry) =>
  keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }],
      [entry.account, BigInt(entry.weight)]
    )
  )
)
const pairHash = (left: Hex, right: Hex) =>
  keccak256(left < right ? concatHex([left, right]) : concatHex([right, left]))
let level = leaves
while (level.length > 1) {
  const next: Hex[] = []
  for (let index = 0; index < level.length; index += 2) {
    next.push(
      index + 1 === level.length
        ? level[index]
        : pairHash(level[index], level[index + 1])
    )
  }
  level = next
}

const bytes = Buffer.alloc(18 + normalized.length * 28)
bytes.write('TGWP', 0, 'ascii')
bytes.writeUInt16BE(1, 4)
bytes.writeBigUInt64BE(BigInt(fixture.chainId), 6)
bytes.writeUInt32BE(normalized.length, 14)
normalized.forEach((entry, index) => {
  Buffer.from(entry.account.slice(2), 'hex').copy(bytes, 18 + index * 28)
  bytes.writeBigUInt64BE(BigInt(entry.weight), 18 + index * 28 + 20)
})
const manifest = `0x${bytes.toString('hex')}`
const digest = `0x${createHash('sha256').update(bytes).digest('hex')}`

const equal = (actual: unknown, expected: unknown, label: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} mismatch\nactual=${JSON.stringify(actual)}\nexpected=${JSON.stringify(expected)}`
    )
  }
}
equal(normalized, fixture.normalized, 'normalization')
equal(leaves, fixture.leaves, 'leaves')
equal(level[0], fixture.priorRoot, 'root')
equal(manifest, fixture.manifest, 'manifest')
equal(digest, fixture.manifestSha256, 'manifest digest')
console.log('weighted-prior Rust/TypeScript fixture parity: ok')
