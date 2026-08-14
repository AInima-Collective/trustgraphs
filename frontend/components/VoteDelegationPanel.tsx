'use client'

import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { type Hex, isAddress, isAddressEqual, zeroAddress } from 'viem'

import {
  clearAgentNotificationConfirmation,
  loadAgentNotificationConfirmation,
  saveAgentNotificationConfirmation,
} from '@/lib/agent-delegation'
import { parseErrorMessage } from '@/lib/error'

import { Address } from './Address'
import { Button } from './Button'
import { Input } from './Input'
import { Label } from './Label'

interface VoteDelegationPanelProps {
  networkId: string
  module: Hex
  principal?: Hex
  currentDelegate: Hex
  isLoading: boolean
  onSetDelegate: (delegate: Hex) => Promise<string | null>
}

export function VoteDelegationPanel({
  networkId,
  module,
  principal,
  currentDelegate,
  isLoading,
  onSetDelegate,
}: VoteDelegationPanelProps) {
  const [delegate, setDelegate] = useState('')
  const [channelLabel, setChannelLabel] = useState('')
  const [notificationConfirmed, setNotificationConfirmed] = useState(false)
  const active = currentDelegate !== zeroAddress

  useEffect(() => {
    if (!principal) return
    setDelegate(active ? currentDelegate : '')
    const saved = loadAgentNotificationConfirmation(
      networkId,
      module,
      principal
    )
    const matches =
      saved && active && isAddressEqual(saved.delegate, currentDelegate)
    setChannelLabel(matches ? saved.channelLabel : '')
    setNotificationConfirmed(!!matches)
  }, [active, currentDelegate, module, networkId, principal])

  const configure = async () => {
    if (!principal) return
    const candidate = delegate.trim()
    if (!isAddress(candidate)) {
      toast.error('Enter a valid agent address')
      return
    }
    if (isAddressEqual(candidate, principal)) {
      toast.error('You cannot delegate voting to yourself')
      return
    }
    if (channelLabel.trim().length < 3 || !notificationConfirmed) {
      toast.error('Confirm a tested notification channel before delegating')
      return
    }

    const receipt = await onSetDelegate(candidate)
    if (!receipt) return
    const saved = saveAgentNotificationConfirmation(
      networkId,
      module,
      principal,
      {
        delegate: candidate,
        channelLabel: channelLabel.trim(),
        confirmedAt: Date.now(),
      }
    )
    if (!saved) {
      toast.error(
        'Delegation succeeded, but this browser could not save the notification receipt.'
      )
    }
  }

  const revoke = async () => {
    if (!principal) return
    try {
      const receipt = await onSetDelegate(zeroAddress)
      if (!receipt) return
      clearAgentNotificationConfirmation(networkId, module, principal)
      setDelegate('')
      setChannelLabel('')
      setNotificationConfirmed(false)
    } catch (error) {
      toast.error(parseErrorMessage(error))
    }
  }

  if (!principal) {
    return (
      <p className="text-xs text-muted-foreground">
        Connect a wallet to configure an agent vote delegate.
      </p>
    )
  }

  return (
    <div className="space-y-4 border border-border bg-muted/20 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="text-sm font-medium">Agent vote delegate</div>
          <p className="max-w-2xl text-xs text-muted-foreground">
            One agent may cast a provisional vote using your published voting
            power. Your own vote always replaces it and becomes final.
          </p>
        </div>
        {active && (
          <div className="text-xs text-muted-foreground">
            Active:{' '}
            <Address textClassName="text-xs" address={currentDelegate} />
          </div>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="vote-delegate">Agent address</Label>
          <Input
            id="vote-delegate"
            value={delegate}
            onChange={(event) => {
              setDelegate(event.target.value)
              setNotificationConfirmed(false)
            }}
            placeholder="0x…"
            spellCheck={false}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="vote-notification">Notification channel</Label>
          <Input
            id="vote-notification"
            value={channelLabel}
            onChange={(event) => {
              setChannelLabel(event.target.value)
              setNotificationConfirmed(false)
            }}
            placeholder="e.g. Signal from my agent runner"
          />
        </div>
      </div>

      <label className="flex items-start gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={notificationConfirmed}
          onChange={(event) => setNotificationConfirmed(event.target.checked)}
        />
        I received a test alert with the agent's analysis and intended vote.
        Delegation stays disabled until this is confirmed.
      </label>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={configure}
          disabled={
            isLoading ||
            !notificationConfirmed ||
            channelLabel.trim().length < 3
          }
        >
          {active ? 'Change delegate' : 'Set delegate'}
        </Button>
        {active && (
          <Button
            size="sm"
            variant="ghostDestructive"
            onClick={revoke}
            disabled={isLoading}
          >
            Revoke delegate
          </Button>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">
        The notification confirmation is stored only in this browser; the
        delegation and every vote receipt are public on-chain. Keep your agent
        runner's notification configuration separately backed up.
      </p>
    </div>
  )
}
