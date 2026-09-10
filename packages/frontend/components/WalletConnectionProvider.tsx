'use client'

import {
  BaseSyntheticEvent,
  createContext,
  useCallback,
  useContext,
  useState,
} from 'react'
import { useAccount, useSwitchChain } from 'wagmi'

import {
  createNetworkAddParams,
  getTargetChainConfig,
  getTargetChainId,
  loadWalletConnectors,
} from '@/lib/wagmi'
import { requestApplicationChainSwitch } from '@/lib/wallet-switch'

const WalletConnectionContext = createContext<{
  _openId: number
  walletOptionsLoading: boolean
  prepareWalletConnectors: () => Promise<void>
  openConnectWallet: (event?: BaseSyntheticEvent) => void
  switchToTarget: () => Promise<boolean>
  switchingTarget: boolean
  switchError: string | null
}>({
  _openId: 0,
  walletOptionsLoading: false,
  prepareWalletConnectors: async () => {},
  openConnectWallet: () => {},
  switchToTarget: async () => false,
  switchingTarget: false,
  switchError: null,
})

export const useWalletConnectionContext = () =>
  useContext(WalletConnectionContext)

export const WalletConnectionProvider = ({
  children,
}: {
  children: React.ReactNode
}) => {
  const [_openId, setOpenId] = useState(0)
  const [walletOptionsLoading, setWalletOptionsLoading] = useState(false)
  const prepareWalletConnectors = useCallback(async () => {
    setWalletOptionsLoading(true)
    try {
      await loadWalletConnectors()
    } finally {
      setWalletOptionsLoading(false)
    }
  }, [])
  const openConnectWallet = useCallback(
    (event?: BaseSyntheticEvent) => {
      event?.stopPropagation()
      // Opening the picker is explicit connect intent. Let the panel appear immediately while
      // its optional vendor connector chunk downloads.
      void prepareWalletConnectors().catch((error) => {
        console.error('Failed to load wallet options:', error)
      })
      setOpenId((openId) => openId + 1)
    },
    [prepareWalletConnectors]
  )

  const { connector } = useAccount()
  const [switchError, setSwitchError] = useState<string | null>(null)
  const { switchChainAsync, isPending: switchingTarget } = useSwitchChain()

  const switchToTarget = useCallback(async () => {
    setSwitchError(null)
    if (!connector) {
      setSwitchError('Connect your wallet before switching networks.')
      return false
    }
    const chain = getTargetChainConfig()
    const { chainId: _chainId, ...addEthereumChainParameter } =
      createNetworkAddParams(chain)
    // Wagmi's active connector handles 4902/unknown-chain responses, including wallet-specific
    // error wrapping. Passing public chain metadata avoids adding our credentialed RPC proxy.
    const result = await requestApplicationChainSwitch(
      () =>
        switchChainAsync({
          connector,
          chainId: getTargetChainId(),
          addEthereumChainParameter,
        }),
      chain.name
    )
    if (!result.ok) setSwitchError(result.message)
    return result.ok
  }, [connector, switchChainAsync])

  return (
    <WalletConnectionContext.Provider
      value={{
        _openId,
        walletOptionsLoading,
        prepareWalletConnectors,
        openConnectWallet,
        switchToTarget,
        switchingTarget,
        switchError,
      }}
    >
      {children}
    </WalletConnectionContext.Provider>
  )
}
