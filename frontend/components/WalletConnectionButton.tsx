'use client'

import { Check, Copy, LoaderCircle, LogOut, User, Wallet } from 'lucide-react'
import { usePlausible } from 'next-plausible'
import type React from 'react'
import { Dispatch, SetStateAction, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { useAccount, useBalance, useConnect, useDisconnect } from 'wagmi'

import { useEns } from '@/hooks/useEns'
import { parseErrorMessage } from '@/lib/error'
import { cn, formatBigNumber } from '@/lib/utils'

import { Button, ButtonLink } from './Button'
import { EthIcon } from './icons/EthIcon'
import { Popup } from './Popup'
import { useWalletConnectionContext } from './WalletConnectionProvider'

export interface WalletConnectionButtonProps {
  className?: string
}

/**
 * wagmi connector ids that are not the name of anything a person owns.
 *
 * `injected` is the big one: it is wagmi's word for "whatever extension put an
 * `ethereum` object on the page", and it shipped into the picker as the literal
 * string "Injected". It is one click from the nav on every public page, and a
 * normal reader has no way to know what it means. See LANDING_PAGE_COPY.md,
 * "Site chrome".
 */
const CONNECTOR_LABELS: Record<string, string> = {
  injected: 'Browser wallet',
  safe: 'Safe',
}

const connectorLabel = (id: string, name: string) =>
  CONNECTOR_LABELS[id] ?? name

export const WalletConnectionButton = ({
  className,
}: WalletConnectionButtonProps) => {
  const { _openId } = useWalletConnectionContext()
  const { address, isConnected } = useAccount()
  const { connectors, connectAsync, isPending: isConnecting } = useConnect()
  const { disconnect } = useDisconnect()
  const plausible = usePlausible()

  const formatAddress = (addr: string) => {
    return `${addr.slice(0, 5)}..${addr.slice(-3)}`
  }

  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) {
      return
    }
    const timeout = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timeout)
  }, [copied])
  const CopyIcon = copied ? Check : Copy

  const setOpenRef = useRef<Dispatch<SetStateAction<boolean>> | null>(null)

  const { data: ethBalance, isLoading: isLoadingEthBalance } = useBalance({
    address: address,
    query: {
      enabled: !!address,
      refetchInterval: 30_000,
    },
  })

  useEffect(() => {
    if (_openId > 0) {
      setOpenRef.current?.(true)
    }
  }, [_openId])

  const { name: ensName } = useEns(address, { enableAvatar: false })
  const accountHref = `/account/${ensName || address}`

  return (
    <>
      <Popup
        position="left"
        setOpenRef={setOpenRef}
        popupPadding={24}
        popupClassName={cn(
          'border border-border',
          isConnected ? '!p-3' : '!p-2'
        )}
        sideOffset={4}
        wrapperClassName={className}
        trigger={{
          type: 'custom',
          Renderer: ({ onClick, open }) => (
            <Button
              variant={open ? 'outline' : 'default'}
              onClick={onClick}
              size="default"
              // 44px rather than the default 36px. On a phone this collapses to
              // an icon-only control, which is exactly the case where an
              // undersized target is hardest to hit.
              className="h-11"
              // ...and the same collapse takes the accessible name with it: the
              // label span is `hidden sm:block`, so below `sm` the only child is
              // an unlabelled lucide icon and the button announces as nothing.
              //
              // The connected name CONTAINS the visible label rather than
              // replacing it. A bare "Account menu" over a button reading
              // "0x123..abc" is a WCAG 2.5.3 failure: voice control repeats what
              // it can see, and "click 0x123" would not reach this button.
              aria-label={
                isConnected
                  ? address
                    ? `Account menu, ${formatAddress(address)}`
                    : 'Account menu'
                  : 'Connect account'
              }
              // The button reveals a panel, and it has to say so: without these
              // a screen-reader user is told nothing happened, and the controls
              // that appeared are eighteen tab stops away at the end of the
              // document, because the panel is portalled into <body>.
              aria-haspopup="dialog"
              aria-expanded={open}
            >
              {isConnecting ? (
                <LoaderCircle
                  size={20}
                  aria-hidden="true"
                  className="sm:hidden animate-spin text-inherit"
                />
              ) : (
                <Wallet
                  aria-hidden="true"
                  className="sm:hidden w-5 h-5 text-inherit"
                />
              )}
              <span className="hidden sm:block">
                {isConnected && address
                  ? formatAddress(address)
                  : isConnecting
                    ? 'Connecting…'
                    : 'Connect account'}
              </span>
            </Button>
          ),
        }}
      >
        {isConnected && address ? (
          <div className="flex flex-col gap-3 text-sm">
            <div className="flex flex-col gap-2 bg-secondary p-3 rounded-md -m-1">
              <p className="text-xs text-muted-foreground font-medium mb-1">
                Optimism Balances
              </p>

              <div className="flex flex-row items-center gap-2 pl-2">
                <EthIcon className="w-5 h-5" />
                <p className="text-foreground font-medium">
                  {isLoadingEthBalance
                    ? '...'
                    : ethBalance
                      ? formatBigNumber(ethBalance.value, ethBalance.decimals)
                      : '?'}{' '}
                  <span className="text-muted-foreground">
                    {ethBalance?.symbol}
                  </span>
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <Button
                className="justify-start gap-3"
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  navigator.clipboard.writeText(address)
                  setCopied(true)
                  // Don't close the popup. Updating the copied state causes this to re-render, which causes the original event target to no longer be contained by the popup, which causes the popup to close.
                  e.stopPropagation()
                }}
              >
                <CopyIcon className="w-4 h-4 text-muted-foreground" />
                <p className="text-sm">Copy address</p>
              </Button>

              <ButtonLink
                href={accountHref}
                className="justify-start gap-3"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setOpenRef.current?.(false)
                }}
              >
                <User className="w-4 h-4 text-muted-foreground" />
                <p className="text-sm">View profile</p>
              </ButtonLink>

              <Button
                variant="ghostDestructive"
                className="justify-start gap-3"
                size="sm"
                onClick={() => {
                  setOpenRef.current?.(false)
                  // Wait for the popup to close before disconnecting to avoid flickering as the popup classes change.
                  setTimeout(() => disconnect(), 200)
                }}
              >
                <LogOut className="!w-4 !h-4" />
                <p className="text-sm">Disconnect</p>
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {connectors && connectors.length > 0 ? (
              <div className="flex flex-col gap-1 text-sm">
                {connectors.map((connector) => (
                  <Button
                    key={connector.id}
                    className="justify-start"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      // Close the popup as connection begins.
                      setOpenRef.current?.(false)

                      plausible('wallet_connect', {
                        props: {
                          wallet: connector.id,
                        },
                      })

                      // Start connection.
                      connectAsync({ connector }).catch((err) => {
                        console.error('Connection errored:', err)
                        toast.error(parseErrorMessage(err))
                        // Reopen the popup on error.
                        setOpenRef.current?.(true)
                      })
                    }}
                    disabled={isConnecting}
                  >
                    {connector.icon ? (
                      // The name is already the button's own text, so the icon
                      // is decoration and repeating it reads the wallet twice.
                      <img alt="" src={connector.icon} className="!w-5 !h-5" />
                    ) : (
                      <Wallet className="w-5 h-5" aria-hidden="true" />
                    )}
                    <p>{connectorLabel(connector.id, connector.name)}</p>
                  </Button>
                ))}
              </div>
            ) : (
              // The condition is `connectors.length === 0`, which is a
              // configuration state rather than a detection result: nothing has
              // been looked for. Say what the reader can do about it.
              <div className="text-muted-foreground text-sm">
                No wallets available in this browser.
              </div>
            )}
          </div>
        )}
      </Popup>
    </>
  )
}
