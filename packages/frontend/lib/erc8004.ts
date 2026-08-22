import { type Hex } from 'viem'

export type Erc8004AgentCompact = {
  key: string
  chainId: string
  registry: Hex
  agentId: string
  owner: Hex | null
}

export type Erc8004AgentSummary = Erc8004AgentCompact & {
  namespace: 'eip155'
  agentWallet: Hex | null
  agentURI: string
  roles: Array<'owner' | 'verified_wallet'>
  name: string | null
  registrationStatus: string
}

export type Erc8004AccountRelations = {
  address: Hex
  owns: Erc8004AgentSummary[]
  verifiedWalletFor: Erc8004AgentSummary[]
}

export const erc8004AgentHref = (
  agent: Pick<Erc8004AgentCompact, 'chainId' | 'registry' | 'agentId'>
) =>
  `/agents/eip155/${agent.chainId}/${agent.registry.toLowerCase()}/${agent.agentId}`

export const erc8004AgentLabel = (
  agent: Pick<Erc8004AgentSummary, 'name' | 'agentId'> | Erc8004AgentCompact
) => ('name' in agent && agent.name ? agent.name : `Agent #${agent.agentId}`)
