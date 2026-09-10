'use client'

import { useAccount } from 'wagmi'

import { useWalletConnectionContext } from '@/components/WalletConnectionProvider'
import { getTargetChainConfig } from '@/lib/wagmi'

/** Shared wallet prerequisite for application actions; ENS keeps its explicit read chain. */
export const useApplicationChain = () => {
  const { chainId, isConnected } = useAccount()
  const targetChain = getTargetChainConfig()
  const { switchToTarget, switchingTarget, switchError } =
    useWalletConnectionContext()
  return {
    targetChain,
    targetChainId: targetChain.id,
    wrongChain: isConnected && chainId !== targetChain.id,
    switchToTarget,
    switchingTarget,
    switchError,
  }
}
