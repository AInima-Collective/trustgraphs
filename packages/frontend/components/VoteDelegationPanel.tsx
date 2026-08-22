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
  /** Called after a delegate is set or revoked, so a host modal can close. */
  onDone?: () => void
}

/**
 * The setup form for agent voting. Rare, deliberate, and gated on confirming a
 * notification channel — so it lives in a modal rather than above the proposals
 * it would otherwise crowd out. Whether an agent is currently active is a fact
 * about every proposal on the page, so that part stays visible outside this
 * form: see `VoteDelegationStatus`.
 */
export function VoteDelegationPanel({
  networkId,
  module,
  principal,
  currentDelegate,
  isLoading,
  onSetDelegate,
  onDone,
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
    onDone?.()
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
      onDone?.()
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
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        An agent can cast a vote for you, using the voting power already
        published for your address. Your own vote always replaces the agent's
        and is the one that counts, so delegating never takes the decision away
        from you.
      </p>

      {active && (
        <div className="flex flex-wrap items-baseline gap-2 border border-border bg-muted/20 p-3 text-xs">
          <span className="text-muted-foreground">Voting for you now:</span>
          <Address textClassName="text-xs" address={currentDelegate} />
        </div>
      )}

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

interface VoteDelegationStatusProps {
  currentDelegate: Hex
  isLoading: boolean
  onManage: () => void
}

/**
 * The one-line delegation state, for the page's context strip.
 *
 * An active delegate changes what happens to every proposal below it — if the
 * principal does nothing, an agent votes — so it is stated in the open rather
 * than hidden behind the modal that configures it. With no delegate set there
 * is nothing to report, so this is only an unobtrusive way in.
 */
export function VoteDelegationStatus({
  currentDelegate,
  isLoading,
  onManage,
}: VoteDelegationStatusProps) {
  const active = currentDelegate !== zeroAddress

  if (isLoading) return null

  // Nothing to report, so this is only a way in: `order-last` parks it in the
  // strip's right-hand cluster beside the other secondary links.
  if (!active) {
    return (
      <button
        type="button"
        onClick={onManage}
        className="order-last self-end text-xs text-muted-foreground underline underline-offset-4 transition-colors hover:text-text"
      >
        Let an agent vote for you
      </button>
    )
  }

  return (
    <div className="space-y-1">
      <div className="tg-label">Agent voting for you</div>
      <div className="flex items-baseline gap-2">
        <Address address={currentDelegate} textClassName="text-sm" monospace />
        <button
          type="button"
          onClick={onManage}
          className="text-xs text-muted-foreground underline underline-offset-4 transition-colors hover:text-text"
        >
          Manage
        </button>
      </div>
    </div>
  )
}
