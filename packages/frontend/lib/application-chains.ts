import type { Chain } from 'viem'
import { anvil, mainnet, sepolia } from 'viem/chains'

import targets from './application-targets.json'

export type ApplicationTarget = keyof typeof targets

const chains = {
  local: { ...anvil, name: 'Local Anvil' },
  sepolia,
  mainnet,
} satisfies Record<ApplicationTarget, Chain>

export const applicationTarget = (target: string): ApplicationTarget => {
  if (!Object.hasOwn(targets, target)) {
    throw new Error(`Unsupported application chain: ${target}`)
  }
  return target as ApplicationTarget
}

export const applicationChain = (target: string): Chain =>
  chains[applicationTarget(target)]

/** The read proxy exposes the deployment chain and Ethereum ENS, never other chains. */
export const applicationRpcChainIds = (target: string): string[] => {
  const selected = applicationTarget(target)
  return Array.from(
    new Set([
      String(mainnet.id),
      ...(selected === 'local' ? [] : [String(targets[selected])]),
    ])
  )
}

/** Keep the application transport when the application already runs on the ENS chain. */
export const applicationAndEnsChains = (
  application: Chain,
  ens: Chain
): readonly [Chain, ...Chain[]] =>
  application.id === ens.id ? [application] : [application, ens]

export const applicationEnvironmentLabel = (target: string): string => {
  const selected = applicationTarget(target)
  return selected === 'local'
    ? 'Local development'
    : selected === 'sepolia'
      ? 'Sepolia testnet'
      : 'Ethereum mainnet'
}
