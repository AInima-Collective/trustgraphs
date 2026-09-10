import {
  type Abi,
  type AbiFunction,
  type AbiParameter,
  type Address,
  type Hex,
  decodeErrorResult,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  isAddress,
  isHex,
  parseAbi,
} from 'viem'

import { trustComposeParamsControllerAbi } from '../composition/contracts'
import {
  gnosisSafeAbi,
  merkleFundDistributorAbi,
  merkleGovModuleAbi,
  merkleSnapshotAbi,
  signerSyncZkModuleAbi,
} from '../contract-abis'
import { contributionsFactoryAbi } from '../contributions-factory'
import { trustgraphsParamsControllerAbi } from '../scoring-params'
import type { GovernanceActionContext } from './types'
import { weightedPriorParamsControllerAbi } from '../weighted-prior/contracts'

export const delayedRecoveryModuleAbi = parseAbi([
  'function schedule(address target,uint256 value,bytes data,uint8 operation) returns (bytes32 actionId)',
  'function execute(uint256 nonce,address target,uint256 value,bytes data,uint8 operation)',
  'function cancel(bytes32 actionId)',
  'function setProposer(address newProposer)',
  'function proposer() view returns (address)',
  'function delay() view returns (uint48)',
  'error ZeroAddress()',
  'error DelayTooShort(uint48 supplied,uint48 minimum)',
  'error OnlyProposer(address caller)',
  'error OnlySafe(address caller)',
  'error NotAuthorizedToCancel(address caller)',
  'error UnknownAction(bytes32 actionId)',
  'error RecoveryDelayNotElapsed(bytes32 actionId,uint256 readyAt)',
  'error SafeExecutionFailed(bytes32 actionId)',
])

export const provingVaultWriteAbi = parseAbi([
  'function setPolicy(bytes32 instanceId,uint64 minPaidIntervalBlocks,uint96 maxPerRootUsd)',
  'function requestWithdrawal(bytes32 instanceId,uint256 ethAmount,uint256 usdcAmount)',
  'function cancelWithdrawal(bytes32 instanceId)',
  'function executeWithdrawal(bytes32 instanceId,address to)',
  'function depositETH(bytes32 instanceId) payable',
  'function depositUSDC(bytes32 instanceId,uint256 amount)',
])

export type KnownContract = {
  address: Address
  label: string
  abi: Abi
}

const catalogEntries: {
  key: Exclude<keyof GovernanceActionContext, 'instanceId'>
  label: string
  abi: Abi
}[] = [
  { key: 'snapshot', label: 'Network snapshot', abi: merkleSnapshotAbi },
  {
    key: 'governanceModule',
    label: 'Governance module',
    abi: merkleGovModuleAbi,
  },
  {
    key: 'fundDistributor',
    label: 'Rewards distributor',
    abi: merkleFundDistributorAbi,
  },
  { key: 'treasurySafe', label: 'Network Safe (treasury)', abi: gnosisSafeAbi },
  {
    key: 'signerSyncModule',
    label: 'Signer sync module',
    abi: signerSyncZkModuleAbi,
  },
  {
    key: 'paramsController',
    label: 'Scoring parameters controller',
    abi: trustgraphsParamsControllerAbi as unknown as Abi,
  },
  {
    key: 'weightedParamsController',
    label: 'Weighted parameters controller',
    abi: weightedPriorParamsControllerAbi as unknown as Abi,
  },
  {
    key: 'compositionParamsController',
    label: 'Composition parameters controller',
    abi: trustComposeParamsControllerAbi as unknown as Abi,
  },
  {
    key: 'contributionsFactory',
    label: 'Contribution-round factory',
    abi: contributionsFactoryAbi as unknown as Abi,
  },
  { key: 'provingVault', label: 'Proving vault', abi: provingVaultWriteAbi },
  {
    key: 'recoveryModule',
    label: 'Recovery module',
    abi: delayedRecoveryModuleAbi,
  },
]

/** The network's own contracts with their ABIs, for building and decoding custom calls. */
export const knownContractAbis = (
  context: GovernanceActionContext
): KnownContract[] =>
  catalogEntries.flatMap(({ key, label, abi }) => {
    const address = context[key]
    return address ? [{ address, label, abi }] : []
  })

export const knownContractFor = (
  context: GovernanceActionContext,
  target: string
): KnownContract | undefined =>
  isAddress(target)
    ? knownContractAbis(context).find(
        (entry) => entry.address.toLowerCase() === target.toLowerCase()
      )
    : undefined

/** Functions a proposal can call: anything that changes state. */
export const writableFunctions = (abi: Abi): AbiFunction[] =>
  abi.filter(
    (item): item is AbiFunction =>
      item.type === 'function' &&
      (item.stateMutability === 'nonpayable' ||
        item.stateMutability === 'payable')
  )

const parameterType = (parameter: AbiParameter): string =>
  'components' in parameter && parameter.components
    ? `(${parameter.components.map(parameterType).join(',')})${parameter.type.slice(5)}`
    : parameter.type

export const functionSignature = (fn: AbiFunction): string =>
  `${fn.name}(${fn.inputs.map(parameterType).join(',')})`

/** A pasted ABI: a JSON array, or one human-readable signature per line. */
export const parseAbiText = (text: string): Abi => {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('Paste an ABI first.')
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed)
    const abi = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.abi)
        ? parsed.abi
        : null
    if (!abi) throw new Error('Expected a JSON ABI array.')
    return abi as Abi
  }
  return parseAbi(
    trimmed
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/[;,]$/, ''))
      .filter(Boolean)
      .map((line) =>
        /^(function|event|error)\s/.test(line) ? line : `function ${line}`
      )
  ) as Abi
}

const parseScalar = (type: string, raw: string): unknown => {
  const value = raw.trim()
  if (type === 'address') {
    if (!isAddress(value)) throw new Error('Enter a valid address.')
    return getAddress(value)
  }
  if (type === 'bool') {
    if (value === 'true' || value === '1') return true
    if (value === 'false' || value === '0') return false
    throw new Error('Enter true or false.')
  }
  if (/^u?int\d*$/.test(type)) {
    if (!/^-?\d+$/.test(value)) throw new Error('Enter a whole number.')
    return BigInt(value)
  }
  if (/^bytes\d*$/.test(type)) {
    if (!isHex(value, { strict: true }) || value.length % 2) {
      throw new Error('Enter byte-aligned hex starting with 0x.')
    }
    const size = Number(type.slice(5))
    if (size && value.length !== 2 + size * 2) {
      throw new Error(`Enter exactly ${size} bytes.`)
    }
    return value
  }
  if (type === 'string') return raw
  throw new Error(`Unsupported type ${type}.`)
}

/**
 * Turn typed text into the value viem encodes: scalars from their own syntax, arrays and
 * tuples from JSON. Throws a message for the person on the first bad value.
 */
export const parseFunctionArgument = (
  parameter: AbiParameter,
  raw: string
): unknown => {
  const arrayMatch = parameter.type.match(/^(.*)\[(\d*)\]$/)
  if (arrayMatch) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('Enter a JSON array, for example ["0x…", "0x…"].')
    }
    if (!Array.isArray(parsed)) throw new Error('Enter a JSON array.')
    const inner: AbiParameter = { ...parameter, type: arrayMatch[1]! }
    return parsed.map((entry) =>
      parseFunctionArgument(
        inner,
        typeof entry === 'string' ? entry : JSON.stringify(entry)
      )
    )
  }
  if (parameter.type === 'tuple' && 'components' in parameter) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('Enter a JSON object with the tuple’s fields.')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Enter a JSON object with the tuple’s fields.')
    }
    const object = parsed as Record<string, unknown>
    return Object.fromEntries(
      (parameter.components ?? []).map((component) => {
        const field = object[component.name ?? '']
        return [
          component.name ?? '',
          parseFunctionArgument(
            component,
            typeof field === 'string' ? field : JSON.stringify(field ?? '')
          ),
        ]
      })
    )
  }
  return parseScalar(parameter.type, raw)
}

export const encodeCustomCall = (
  abi: Abi,
  fn: AbiFunction,
  args: readonly string[]
): Hex => {
  const parsed = fn.inputs.map((input, index) =>
    parseFunctionArgument(input, args[index] ?? '')
  )
  return encodeFunctionData({
    abi: [fn] as Abi,
    functionName: fn.name,
    args: parsed,
  })
}

const stringifyValue = (value: unknown): string =>
  typeof value === 'bigint'
    ? value.toString()
    : typeof value === 'string'
      ? value
      : typeof value === 'boolean'
        ? String(value)
        : JSON.stringify(value, (_, entry) =>
            typeof entry === 'bigint' ? entry.toString() : entry
          )

export type DecodedCall = {
  contract: KnownContract
  functionName: string
  signature: string
  args: { name: string; type: string; value: string }[]
}

/** Read a custom call against the network's own ABIs so reviewers see the function and args. */
export const decodeKnownCall = (
  context: GovernanceActionContext,
  target: string,
  data: Hex
): DecodedCall | null => {
  const contract = knownContractFor(context, target)
  if (!contract || !isHex(data) || data.length < 10) return null
  try {
    const decoded = decodeFunctionData({ abi: contract.abi, data })
    const fn = contract.abi.find(
      (item): item is AbiFunction =>
        item.type === 'function' &&
        item.name === decoded.functionName &&
        item.inputs.length === (decoded.args?.length ?? 0)
    )
    if (!fn) return null
    return {
      contract,
      functionName: decoded.functionName,
      signature: functionSignature(fn),
      args: fn.inputs.map((input, index) => ({
        name: input.name || `arg${index}`,
        type: parameterType(input),
        value: stringifyValue((decoded.args as readonly unknown[])[index]),
      })),
    }
  } catch {
    return null
  }
}

/** A revert's data as a sentence, using the network's ABIs plus the standard Error and Panic. */
export const describeRevertData = (
  context: GovernanceActionContext,
  data: Hex
): string | null => {
  if (!isHex(data) || data.length < 10) return null
  const abis = [...knownContractAbis(context).map((entry) => entry.abi), []]
  for (const abi of abis) {
    try {
      const decoded = decodeErrorResult({ abi, data })
      const args = (decoded.args ?? []) as readonly unknown[]
      if (decoded.errorName === 'Error') return String(args[0] ?? 'reverted')
      if (decoded.errorName === 'Panic')
        return `Panic ${stringifyValue(args[0])}`
      return args.length
        ? `${decoded.errorName}(${args.map(stringifyValue).join(', ')})`
        : decoded.errorName
    } catch {
      continue
    }
  }
  return null
}
