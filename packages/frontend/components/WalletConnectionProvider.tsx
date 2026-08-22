'use client'

import {
  BaseSyntheticEvent,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react'
import { useAccount, useSwitchChain } from 'wagmi'

import {
  createNetworkAddParams,
  getTargetChainConfig,
  getTargetChainId,
  loadWalletConnectors,
} from '@/lib/wagmi'

const WalletConnectionContext = createContext<{
  _openId: number
  walletOptionsLoading: boolean
  prepareWalletConnectors: () => Promise<void>
  openConnectWallet: (event?: BaseSyntheticEvent) => void
}>({
  _openId: 0,
  walletOptionsLoading: false,
  prepareWalletConnectors: async () => {},
  openConnectWallet: () => {},
})

export const useWalletConnectionContext = () =>
  useContext(WalletConnectionContext)
export const useOpenWalletConnector = () =>
  useWalletConnectionContext().openConnectWallet

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

  const addTargetNetwork = async () => {
    try {
      const chainConfig = getTargetChainConfig()
      const networkParams = createNetworkAddParams(chainConfig)

      await window.ethereum?.request({
        method: 'wallet_addEthereumChain',
        params: [networkParams],
      })

      console.log(`Added network: ${chainConfig.name} (${chainConfig.id})`)
    } catch (err) {
      console.error('Failed to add target network:', err)
      throw err
    }
  }

  const { switchChainAsync } = useSwitchChain()
  const { isConnected, chain } = useAccount()

  const handleSwitchToTarget = async () => {
    try {
      const targetChainId = getTargetChainId()
      await switchChainAsync({ chainId: targetChainId })
    } catch (err) {
      console.error('Failed to switch network:', err)
      try {
        await addTargetNetwork()
        const targetChainId = getTargetChainId()
        await switchChainAsync({ chainId: targetChainId })
      } catch (addErr) {
        console.error('Failed to add and switch network:', addErr)
      }
    }
  }

  // Auto-switch to target network when connected to wrong chain
  useEffect(() => {
    const targetChainId = getTargetChainId()
    const targetChainConfig = getTargetChainConfig()

    if (isConnected && (!chain || chain.id !== targetChainId)) {
      console.log(
        `Current chain: ${chain?.id || 'unknown'}, switching to target chain: ${
          targetChainConfig.name
        } (${targetChainId})`
      )
      handleSwitchToTarget()
    }
  }, [isConnected, chain])

  return (
    <WalletConnectionContext.Provider
      value={{
        _openId,
        walletOptionsLoading,
        prepareWalletConnectors,
        openConnectWallet,
      }}
    >
      {children}
    </WalletConnectionContext.Provider>
  )
}
