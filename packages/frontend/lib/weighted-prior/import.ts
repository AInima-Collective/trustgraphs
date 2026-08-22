import {
  type Address,
  type Hex,
  bytesToHex,
  getAddress,
  isAddress,
  sha256,
  stringToBytes,
  zeroAddress,
} from 'viem'

import { normalizeEnsName } from '../ens'
import {
  MAX_PRIOR_ENTRIES,
  type PriorEntry,
  type RawPriorEntry,
  SCALE,
  canonicalManifest,
  normalize,
  priorRoot,
} from './core'

export const WEIGHTED_INPUT_SCHEMA = 'trustgraph-weighted-prior-input-v1'
export const WEIGHTED_PROVENANCE_SCHEMA =
  'trustgraph-weighted-prior-provenance-v1'
export const MAX_WEIGHTED_IMPORT_BYTES = 2 * 1024 * 1024
export const U64_MAX = 18_446_744_073_709_551_615n

const DECIMAL = /^(0|[1-9][0-9]{0,19})(\.[0-9]{0,17}[1-9])?$/

export type WeightedSourceFormat = 'csv' | 'json'

export interface WeightedFieldError {
  code:
    | 'file-size'
    | 'encoding'
    | 'syntax'
    | 'schema'
    | 'chain'
    | 'count'
    | 'account'
    | 'weight'
    | 'duplicate'
    | 'normalized-zero'
  field: string
  message: string
  row?: number
}

export class WeightedImportError extends Error {
  constructor(public readonly issues: WeightedFieldError[]) {
    super(issues.map((issue) => issue.message).join('; '))
    this.name = 'WeightedImportError'
  }
}

export interface ParsedWeightedRow {
  identifier: string
  weight: string
  row: number
}

export interface ParsedWeightedSource {
  format: WeightedSourceFormat
  chainId: bigint
  rows: ParsedWeightedRow[]
  originalBytes: Uint8Array
  originalSha256: Hex
}

export interface EnsResolutionRecord {
  name: string
  address: Address
  blockNumber: string
  blockHash: Hex
}

export interface ResolutionAnchor {
  chainId: number
  blockNumber: bigint
  blockHash: Hex
}

export type EnsResolverAtBlock = (
  name: string,
  anchor: ResolutionAnchor
) => Promise<Address | null>

export interface WeightedProvenanceInput {
  sourceUri?: string
  author?: string
  license?: string
  transform?: string
}

export interface WeightedConcentration {
  largestWeight: bigint
  largestAccount: Hex
  top10Weight: bigint
  hhiBps: bigint
}

export interface WeightedImportArtifacts {
  source: ParsedWeightedSource
  rawEntries: RawPriorEntry[]
  normalizedEntries: PriorEntry[]
  ensResolutions: EnsResolutionRecord[]
  canonicalCsv: string
  canonicalJson: string
  canonicalCsvSha256: Hex
  canonicalJsonSha256: Hex
  manifest: Hex
  priorRoot: Hex
  priorCount: number
  manifestSha256: Hex
  provenanceJson: string
  metadataDigest: Hex
  concentration: WeightedConcentration
}

export interface WeightedExportArtifact {
  name: string
  label: string
  body: string | Uint8Array
  type: string
}

export class WeightedEnsResolutionChangedError extends Error {
  constructor(
    public readonly changes: Array<{
      name: string
      previousAddress: Address
      currentAddress: Address
    }>,
    public readonly rebuilt: WeightedImportArtifacts
  ) {
    super(
      `${changes.map((change) => change.name).join(', ')} changed ENS resolution. Review the rebuilt manifest before signing.`
    )
    this.name = 'WeightedEnsResolutionChangedError'
  }
}

const digest = (bytes: Uint8Array): Hex => sha256(bytesToHex(bytes))
const digestText = (text: string): Hex => digest(stringToBytes(text))

const ADDRESS_ONLY_ANCHOR: ResolutionAnchor = {
  chainId: 1,
  blockNumber: 0n,
  blockHash: `0x${'0'.repeat(64)}`,
}

const fail = (issue: WeightedFieldError): never => {
  throw new WeightedImportError([issue])
}

const parseChain = (value: unknown, expectedChainId: bigint): bigint => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    return fail({
      code: 'chain',
      field: 'chainId',
      message: 'chainId must be a canonical decimal string.',
    })
  }
  const chainId = BigInt(value)
  if (chainId === 0n || chainId > U64_MAX) {
    return fail({
      code: 'chain',
      field: 'chainId',
      message: 'chainId must fit a nonzero uint64.',
    })
  }
  if (chainId !== expectedChainId) {
    return fail({
      code: 'chain',
      field: 'chainId',
      message: `This file is for chain ${chainId}, but the wallet flow is on chain ${expectedChainId}.`,
    })
  }
  return chainId
}

const validateRows = (rows: ParsedWeightedRow[]): ParsedWeightedRow[] => {
  const issues: WeightedFieldError[] = []
  if (rows.length === 0 || rows.length > MAX_PRIOR_ENTRIES) {
    issues.push({
      code: 'count',
      field: 'entries',
      message: `A prior must contain 1 to ${MAX_PRIOR_ENTRIES} entries; received ${rows.length}.`,
    })
  }
  for (const row of rows.slice(0, MAX_PRIOR_ENTRIES + 1)) {
    if (!row.identifier) {
      issues.push({
        code: 'account',
        field: `entries[${row.row - 1}].account`,
        row: row.row,
        message: `Row ${row.row}: account is required.`,
      })
    }
    if (!DECIMAL.test(row.weight) || row.weight === '0') {
      issues.push({
        code: 'weight',
        field: `entries[${row.row - 1}].weight`,
        row: row.row,
        message: `Row ${row.row}: weight must be a positive canonical decimal with at most 18 fractional digits; signs, exponents, leading zeros, and trailing fractional zeros are not allowed.`,
      })
    }
  }
  if (issues.length) throw new WeightedImportError(issues)
  return rows
}

/** Small RFC-4180 reader for human imports. Canonical output never contains quotes. */
const csvRecords = (text: string): string[][] => {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index++
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"' && field.length === 0) {
      quoted = true
    } else if (char === ',') {
      record.push(field)
      field = ''
    } else if (char === '\n') {
      record.push(field.replace(/\r$/, ''))
      records.push(record)
      record = []
      field = ''
    } else {
      field += char
    }
  }
  if (quoted) {
    return fail({
      code: 'syntax',
      field: 'file',
      message: 'CSV contains an unterminated quoted field.',
    })
  }
  if (field.length || record.length) {
    record.push(field.replace(/\r$/, ''))
    records.push(record)
  }
  while (records.at(-1)?.every((value) => !value.trim())) records.pop()
  return records
}

const decode = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return fail({
      code: 'encoding',
      field: 'file',
      message: 'The prior file must be valid UTF-8.',
    })
  }
}

export const parseWeightedSource = (
  input: Uint8Array | string,
  format: WeightedSourceFormat,
  expectedChainId: bigint
): ParsedWeightedSource => {
  const originalBytes =
    typeof input === 'string' ? stringToBytes(input) : new Uint8Array(input)
  if (originalBytes.byteLength > MAX_WEIGHTED_IMPORT_BYTES) {
    return fail({
      code: 'file-size',
      field: 'file',
      message: `The prior file is ${originalBytes.byteLength.toLocaleString()} bytes; the limit is ${MAX_WEIGHTED_IMPORT_BYTES.toLocaleString()} bytes.`,
    })
  }
  const decoded = decode(originalBytes)
  const text = decoded.startsWith('\uFEFF') ? decoded.slice(1) : decoded
  let rows: ParsedWeightedRow[]
  let chainId = expectedChainId

  if (format === 'csv') {
    const records = csvRecords(text)
    const header = records.shift()?.map((value) => value.trim().toLowerCase())
    if (
      !header ||
      header.length !== 2 ||
      header[0] !== 'account' ||
      header[1] !== 'weight'
    ) {
      return fail({
        code: 'schema',
        field: 'header',
        message: 'CSV header must be exactly account,weight.',
      })
    }
    rows = records.map((record, index) => ({
      identifier: (record[0] ?? '').trim(),
      weight: (record[1] ?? '').trim(),
      row: index + 2,
    }))
    if (records.some((record) => record.length !== 2)) {
      return fail({
        code: 'schema',
        field: 'entries',
        message: 'Every CSV row must contain exactly account and weight.',
      })
    }
  } else {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return fail({
        code: 'syntax',
        field: 'file',
        message: 'JSON could not be parsed.',
      })
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return fail({
        code: 'schema',
        field: 'file',
        message: 'JSON must be an object with schema, chainId, and entries.',
      })
    }
    const object = value as Record<string, unknown>
    if (object.schema !== WEIGHTED_INPUT_SCHEMA) {
      return fail({
        code: 'schema',
        field: 'schema',
        message: `JSON schema must be ${WEIGHTED_INPUT_SCHEMA}.`,
      })
    }
    chainId = parseChain(object.chainId, expectedChainId)
    if (!Array.isArray(object.entries)) {
      return fail({
        code: 'schema',
        field: 'entries',
        message: 'JSON entries must be an array.',
      })
    }
    rows = object.entries.map((entry, index) => {
      const objectEntry =
        entry && typeof entry === 'object' && !Array.isArray(entry)
          ? (entry as Record<string, unknown>)
          : {}
      return {
        identifier:
          typeof objectEntry.account === 'string'
            ? objectEntry.account.trim()
            : '',
        // Consensus decimals are strings. JSON numbers have already lost source precision.
        weight:
          typeof objectEntry.weight === 'string'
            ? objectEntry.weight.trim()
            : '',
        row: index + 1,
      }
    })
  }

  return {
    format,
    chainId,
    rows: validateRows(rows),
    originalBytes,
    originalSha256: digest(originalBytes),
  }
}

export const requiresEnsResolution = (source: ParsedWeightedSource): boolean =>
  source.rows.some(
    (row) =>
      !isAddress(row.identifier, { strict: false }) &&
      normalizeEnsName(row.identifier) !== null
  )

const concentration = (entries: PriorEntry[]): WeightedConcentration => {
  const descending = [...entries].sort((left, right) =>
    left.weight === right.weight
      ? left.account.localeCompare(right.account)
      : left.weight > right.weight
        ? -1
        : 1
  )
  const top10Weight = descending
    .slice(0, 10)
    .reduce((sum, entry) => sum + entry.weight, 0n)
  const squareSum = entries.reduce(
    (sum, entry) => sum + entry.weight * entry.weight,
    0n
  )
  return {
    largestWeight: descending[0].weight,
    largestAccount: descending[0].account,
    top10Weight,
    hhiBps: (squareSum * 10_000n) / (SCALE * SCALE),
  }
}

const canonicalOutputs = (chainId: bigint, entries: RawPriorEntry[]) => {
  const canonicalCsv = `account,weight\n${entries
    .map((entry) => `${entry.account},${entry.weight}`)
    .join('\n')}\n`
  const canonicalJson = JSON.stringify({
    schema: WEIGHTED_INPUT_SCHEMA,
    chainId: chainId.toString(),
    entries: entries.map((entry) => ({
      account: entry.account,
      weight: entry.weight,
    })),
  })
  return { canonicalCsv, canonicalJson }
}

export const resolveWeightedSource = async (
  source: ParsedWeightedSource,
  anchor: ResolutionAnchor,
  resolveEns: EnsResolverAtBlock,
  provenance: WeightedProvenanceInput = {}
): Promise<WeightedImportArtifacts> => {
  const issues: WeightedFieldError[] = []
  const resolved: Array<RawPriorEntry & { row: number }> = []
  const ensResolutions: EnsResolutionRecord[] = []
  const rowResults: Array<
    | {
        entry: RawPriorEntry & { row: number }
        resolution?: EnsResolutionRecord
      }
    | { issue: WeightedFieldError }
  > = new Array(source.rows.length)
  let cursor = 0

  // ENS is an import convenience, not consensus. Bound requests so a human file with many names
  // cannot fan out thousands of RPC calls at once, while avoiding a serial network round trip per
  // row. Results are collected back in source order so field errors remain deterministic.
  const workers = Array.from(
    { length: Math.min(8, source.rows.length) },
    async () => {
      while (cursor < source.rows.length) {
        const index = cursor++
        const row = source.rows[index]
        let address: Address | null = null
        let resolution: EnsResolutionRecord | undefined
        if (isAddress(row.identifier, { strict: false })) {
          address = getAddress(row.identifier)
        } else {
          const name = normalizeEnsName(row.identifier)
          if (!name) {
            rowResults[index] = {
              issue: {
                code: 'account',
                field: `entries[${row.row - 1}].account`,
                row: row.row,
                message: `Row ${row.row}: account is not an EVM address or valid ENS name.`,
              },
            }
            continue
          }
          try {
            address = await resolveEns(name, anchor)
          } catch (error) {
            rowResults[index] = {
              issue: {
                code: 'account',
                field: `entries[${row.row - 1}].account`,
                row: row.row,
                message: `Row ${row.row}: ${name} could not be resolved at finalized block ${anchor.blockNumber}: ${error instanceof Error ? error.message : String(error)}`,
              },
            }
            continue
          }
          if (!address || address.toLowerCase() === zeroAddress) {
            rowResults[index] = {
              issue: {
                code: 'account',
                field: `entries[${row.row - 1}].account`,
                row: row.row,
                message: `Row ${row.row}: ${name} has no nonzero address for chain ${source.chainId}.`,
              },
            }
            continue
          }
          address = getAddress(address)
          resolution = {
            name,
            address,
            blockNumber: anchor.blockNumber.toString(),
            blockHash: anchor.blockHash,
          }
        }
        if (address.toLowerCase() === zeroAddress) {
          rowResults[index] = {
            issue: {
              code: 'account',
              field: `entries[${row.row - 1}].account`,
              row: row.row,
              message: `Row ${row.row}: the zero address is not allowed.`,
            },
          }
          continue
        }
        rowResults[index] = {
          entry: {
            account: address.toLowerCase() as Hex,
            weight: row.weight,
            row: row.row,
          },
          resolution,
        }
      }
    }
  )
  await Promise.all(workers)
  for (const result of rowResults) {
    if ('issue' in result) issues.push(result.issue)
    else {
      resolved.push(result.entry)
      if (result.resolution) ensResolutions.push(result.resolution)
    }
  }
  const seen = new Map<string, number>()
  for (const entry of resolved) {
    const earlier = seen.get(entry.account)
    if (earlier !== undefined) {
      issues.push({
        code: 'duplicate',
        field: `entries[${entry.row - 1}].account`,
        row: entry.row,
        message: `Row ${entry.row}: account duplicates row ${earlier} after ENS resolution.`,
      })
    } else {
      seen.set(entry.account, entry.row)
    }
  }
  if (issues.length) throw new WeightedImportError(issues)

  const rawEntries = resolved
    .map(({ account, weight }) => ({ account, weight }))
    .sort((left, right) => left.account.localeCompare(right.account))
  let normalizedEntries: PriorEntry[]
  try {
    normalizedEntries = normalize(rawEntries)
  } catch (error) {
    return fail({
      code: String(error).includes('normalized to zero')
        ? 'normalized-zero'
        : 'weight',
      field: 'entries',
      message: error instanceof Error ? error.message : String(error),
    })
  }
  const outputs = canonicalOutputs(source.chainId, rawEntries)
  const manifest = canonicalManifest(source.chainId, normalizedEntries)
  const root = priorRoot(normalizedEntries)
  const manifestSha256 = sha256(manifest)
  const canonicalCsvSha256 = digestText(outputs.canonicalCsv)
  const canonicalJsonSha256 = digestText(outputs.canonicalJson)
  const provenanceJson = JSON.stringify({
    schema: WEIGHTED_PROVENANCE_SCHEMA,
    chainId: source.chainId.toString(),
    source: {
      format: source.format,
      uri: provenance.sourceUri?.trim() || null,
      sha256: source.originalSha256,
      bytes: source.originalBytes.byteLength,
    },
    canonical: {
      csvSha256: canonicalCsvSha256,
      jsonSha256: canonicalJsonSha256,
    },
    ensResolutions: [...ensResolutions].sort((left, right) =>
      left.name.localeCompare(right.name)
    ),
    author: provenance.author?.trim() || null,
    license: provenance.license?.trim() || null,
    transform: provenance.transform?.trim() || null,
  })

  return {
    source,
    rawEntries,
    normalizedEntries,
    ensResolutions,
    ...outputs,
    canonicalCsvSha256,
    canonicalJsonSha256,
    manifest,
    priorRoot: root,
    priorCount: normalizedEntries.length,
    manifestSha256,
    provenanceJson,
    metadataDigest: sha256(bytesToHex(stringToBytes(provenanceJson))),
    concentration: concentration(normalizedEntries),
  }
}

/** Import an address-only file without making ENS/mainnet availability a prerequisite. */
export const resolveAddressOnlyWeightedSource = (
  source: ParsedWeightedSource,
  provenance: WeightedProvenanceInput = {}
): Promise<WeightedImportArtifacts> => {
  if (requiresEnsResolution(source)) {
    return fail({
      code: 'account',
      field: 'entries',
      message: 'ENS names require a finalized-block resolver.',
    })
  }
  return resolveWeightedSource(
    source,
    ADDRESS_ONLY_ANCHOR,
    async () => null,
    provenance
  )
}

/** Re-resolve every imported ENS name at a fresh finalized anchor immediately before signing. */
export const recheckWeightedSource = async (
  previous: WeightedImportArtifacts,
  freshAnchor: ResolutionAnchor,
  resolveEns: EnsResolverAtBlock,
  provenance: WeightedProvenanceInput = {}
): Promise<WeightedImportArtifacts> => {
  const rebuilt = await resolveWeightedSource(
    previous.source,
    freshAnchor,
    resolveEns,
    provenance
  )
  const before = new Map(
    previous.ensResolutions.map((record) => [
      record.name,
      record.address.toLowerCase() as Address,
    ])
  )
  const changes = rebuilt.ensResolutions.flatMap((record) => {
    const old = before.get(record.name)
    return old && old !== record.address.toLowerCase()
      ? [
          {
            name: record.name,
            previousAddress: old,
            currentAddress: record.address,
          },
        ]
      : []
  })
  if (changes.length) {
    throw new WeightedEnsResolutionChangedError(changes, rebuilt)
  }
  // The preview provenance deliberately records the block the signer reviewed. The fresh block is
  // a safeguard, not a silent metadata rewrite; unchanged results keep the exact simulated bytes.
  return previous
}

export const equalWeightCsv = (accounts: Hex[]): string =>
  `account,weight\n${[...accounts]
    .map((account) => account.toLowerCase())
    .sort()
    .map((account) => `${account},1`)
    .join('\n')}\n`

export const weightedExportArtifacts = (
  artifacts: WeightedImportArtifacts
): WeightedExportArtifact[] => [
  {
    name: 'weighted-prior.csv',
    label: 'CSV',
    body: artifacts.canonicalCsv,
    type: 'text/csv;charset=utf-8',
  },
  {
    name: 'weighted-prior.json',
    label: 'JSON',
    body: artifacts.canonicalJson,
    type: 'application/json',
  },
  {
    name: 'weighted-prior.tgwp',
    label: 'TGWP',
    body: Uint8Array.from(
      artifacts.manifest
        .slice(2)
        .match(/../g)!
        .map((byte) => Number.parseInt(byte, 16))
    ),
    type: 'application/octet-stream',
  },
  {
    name: 'weighted-prior-provenance.json',
    label: 'Provenance',
    body: artifacts.provenanceJson,
    type: 'application/json',
  },
]

export const percent = (weight: bigint, decimals = 2): string => {
  const factor = 10n ** BigInt(decimals)
  const scaled = (weight * 100n * factor + SCALE / 2n) / SCALE
  const whole = scaled / factor
  const fraction = (scaled % factor).toString().padStart(decimals, '0')
  return decimals === 0 ? `${whole}%` : `${whole}.${fraction}%`
}
