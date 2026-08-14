import { type Hex, isAddress, zeroAddress } from 'viem'

export const ERC8004_REGISTRATION_TYPE =
  'https://eips.ethereum.org/EIPS/eip-8004#registration-v1'

export const erc8004RegistryKey = (
  chainId: number | string,
  registry: string
) => `eip155:${chainId}:${registry.toLowerCase()}`

export const erc8004AgentKey = (
  chainId: number | string,
  registry: string,
  agentId: bigint | number | string
) => `agent:${erc8004RegistryKey(chainId, registry)}:${BigInt(agentId)}`

/** The reference implementation emits packed 20-byte addresses; accept ABI-padded addresses too. */
export const decodeAgentWallet = (value: Hex): Hex | null => {
  if (value === '0x') return null
  const raw = value.slice(2)
  const candidate =
    raw.length === 40
      ? `0x${raw}`
      : raw.length === 64 && /^0{24}/.test(raw)
        ? `0x${raw.slice(24)}`
        : null
  if (!candidate || !isAddress(candidate)) return null
  return candidate.toLowerCase() as Hex
}

export type Erc8004Position = {
  blockNumber: bigint
  transactionIndex: number
  logIndex: number
}

export type Erc8004LifecycleEvent = Erc8004Position &
  (
    | { kind: 'Registered'; agentId: bigint; owner: Hex; uri: string }
    | { kind: 'URIUpdated'; agentId: bigint; uri: string }
    | { kind: 'MetadataSet'; agentId: bigint; key: string; value: Hex }
    | { kind: 'Transfer'; agentId: bigint; from: Hex; to: Hex }
  )

export type Erc8004LifecycleAgent = {
  agentId: bigint
  owner: Hex | null
  agentWallet: Hex | null
  uri: string
}

export type Erc8004RelationChange = Erc8004Position & {
  agentId: bigint
  relation: 'owner' | 'verified_wallet'
  account: Hex
  active: boolean
}

const comparePosition = (a: Erc8004Position, b: Erc8004Position) =>
  a.blockNumber === b.blockNumber
    ? a.transactionIndex === b.transactionIndex
      ? a.logIndex - b.logIndex
      : a.transactionIndex - b.transactionIndex
    : a.blockNumber < b.blockNumber
      ? -1
      : 1

/**
 * Pure lifecycle replay used by fixtures and audits. Ponder supplies events in this order in
 * production; sorting here makes the transfer-before/after-wallet invariant explicit and testable.
 */
export const replayErc8004Lifecycle = (events: Erc8004LifecycleEvent[]) => {
  const agents = new Map<bigint, Erc8004LifecycleAgent>()
  const relations: Erc8004RelationChange[] = []

  for (const event of [...events].sort(comparePosition)) {
    const current = agents.get(event.agentId) ?? {
      agentId: event.agentId,
      owner: null,
      agentWallet: null,
      uri: '',
    }

    if (event.kind === 'Registered') {
      current.owner = event.owner.toLowerCase() as Hex
      current.uri = event.uri
    } else if (event.kind === 'URIUpdated') {
      current.uri = event.uri
    } else if (event.kind === 'MetadataSet' && event.key === 'agentWallet') {
      const next = decodeAgentWallet(event.value)
      if (current.agentWallet && current.agentWallet !== next) {
        relations.push({
          ...event,
          agentId: event.agentId,
          relation: 'verified_wallet',
          account: current.agentWallet,
          active: false,
        })
      }
      if (next && next !== current.agentWallet) {
        relations.push({
          ...event,
          agentId: event.agentId,
          relation: 'verified_wallet',
          account: next,
          active: true,
        })
      }
      current.agentWallet = next
    } else if (event.kind === 'Transfer') {
      const from = event.from.toLowerCase() as Hex
      const to = event.to.toLowerCase() as Hex
      if (from !== zeroAddress) {
        relations.push({
          ...event,
          agentId: event.agentId,
          relation: 'owner',
          account: from,
          active: false,
        })
      }
      if (to !== zeroAddress) {
        relations.push({
          ...event,
          agentId: event.agentId,
          relation: 'owner',
          account: to,
          active: true,
        })
      }
      // The official contract emits a wallet-clearing MetadataSet first. Keep this defensive clear
      // so a non-conforming registry can never make a transferred wallet look verified.
      if (from !== zeroAddress && current.agentWallet) {
        relations.push({
          ...event,
          agentId: event.agentId,
          relation: 'verified_wallet',
          account: current.agentWallet,
          active: false,
        })
      }
      current.owner = to === zeroAddress ? null : to
      if (from !== zeroAddress) current.agentWallet = null
    }

    agents.set(event.agentId, current)
  }

  return { agents, relations }
}
