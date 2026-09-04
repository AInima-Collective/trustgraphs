import { keccak256, stringToBytes } from 'viem'

export const CONSTITUTIONAL_ROLE = keccak256(
  stringToBytes('CONSTITUTIONAL_ROLE')
)

export type SubnetworkPower = {
  parentModule: boolean
  constitutionalRole: boolean
  recoveryProposer: boolean
  parentModuleDelay: bigint | null
}

export const classifySubnetworkPower = (power: SubnetworkPower) => {
  const instruments = [
    ...(power.parentModule ? ['parent-module'] : []),
    ...(power.constitutionalRole ? ['constitutional-role'] : []),
    ...(power.recoveryProposer ? ['recovery-proposer'] : []),
  ]
  const tier = power.parentModule
    ? power.parentModuleDelay === 0n
      ? 'admin'
      : 'guardian'
    : power.constitutionalRole
      ? 'department'
      : power.recoveryProposer
        ? 'guardian'
        : 'label'
  return { verified: instruments.length > 0, instruments, tier }
}
