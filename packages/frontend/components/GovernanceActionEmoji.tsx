import type { GovernanceComposerActionKey } from '@/lib/actions'
import { cn } from '@/lib/utils'

// Shared by the library, editable drafts, and decoded proposal actions.
const actionEmojis = {
  'send-eth': '💸',
  'send-erc20': '🪙',
  'fund-rewards': '🎁',
  'set-rewards-paused': '⏯️',
  'set-rewards-fee-recipient': '📬',
  'set-rewards-fee-percentage': '🏷️',
  'set-rewards-allowlist-enabled': '📋',
  'set-rewards-distributor-allowance': '🎟️',
  'update-scoring-params': '🎛️',
  'rotate-weighted-prior': '⚖️',
  'cancel-weighted-prior': '↩️',
  'propose-composition-policy': '🧩',
  'cancel-composition-policy': '🗑️',
  'update-network-profile': '📝',
  'set-operational-role': '🔑',
  'propose-constitutional-transfer': '🤝',
  'cancel-constitutional-transfer': '✋',
  'set-governance-quorum': '🗳️',
  'set-governance-voting-delay': '⏳',
  'set-governance-voting-period': '📅',
  'set-governance-execution-delay': '⏱️',
  'set-governance-delegatecall-target': '🔏',
  'cancel-governance-proposal': '🚫',
  'set-signer-sync-paused': '🔄',
  'set-signer-params-hash': '✍️',
  'set-snapshot-verifier': '🔍',
  'set-snapshot-accumulator': '📚',
  'set-snapshot-anchor-registry': '⚓',
  'enable-safe-module': '🔌',
  'disable-safe-module': '🔒',
  'set-safe-guard': '🛡️',
  'swap-safe-owner': '🔀',
  'set-recovery-proposer': '🛟',
  'cancel-recovery-action': '🛑',
  'set-vault-policy': '🏦',
  'request-vault-withdrawal': '📤',
  'cancel-vault-withdrawal': '↪️',
  'execute-vault-withdrawal': '💰',
  'create-contribution-round': '🌱',
  custom: '⚙️',
} satisfies Record<
  GovernanceComposerActionKey | 'set-signer-params-hash',
  string
>

export function GovernanceActionEmoji({
  actionKey,
  className,
}: {
  actionKey: string
  className?: string
}) {
  const emoji = Object.hasOwn(actionEmojis, actionKey)
    ? actionEmojis[actionKey as keyof typeof actionEmojis]
    : actionEmojis.custom

  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center text-lg leading-none',
        className
      )}
    >
      {emoji}
    </span>
  )
}
