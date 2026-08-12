'use client'

import { Code2, Send, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import type { ComponentType } from 'react'
import { formatEther } from 'viem'

import {
  decodeParameterUpdateAction,
  decodeSignerParamsHashAction,
  formatFixed,
} from '@/lib/scoring-params'
import { cn } from '@/lib/utils'

import { Card } from './Card'
import { CopyableText } from './CopyableText'

export type DisplayProposalAction = {
  target: string
  value: string
  data: string
  operation?: number
  description?: string
  contractName?: string
  functionSignature?: string
}

type ActionKind = 'signer-sync' | 'scoring-update' | 'transfer' | 'custom'

type ActionPresentation = {
  kind: ActionKind
  title: string
  summary: string
  badge: string
  icon: ComponentType<{ className?: string }>
  hash?: string
  evidenceURI?: string
  resultingSettings?: string[]
}

const proposalDiffLines = (description?: string) =>
  (description ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes(' → '))

const presentAction = (action: DisplayProposalAction): ActionPresentation => {
  const signerHash = decodeSignerParamsHashAction(action.data)
  if (signerHash) {
    return {
      kind: 'signer-sync',
      title: 'Synchronize signer rules',
      summary:
        'Point the signer-selection module at the new scoring configuration.',
      badge: 'Signer rules',
      icon: ShieldCheck,
      hash: signerHash,
    }
  }

  const update = decodeParameterUpdateAction(action.data)
  if (update) {
    return {
      kind: 'scoring-update',
      title: 'Publish the new scoring configuration',
      summary:
        'Make these settings the network’s current, versioned scoring configuration.',
      badge: 'Scoring settings',
      icon: SlidersHorizontal,
      hash: update.proposedHash,
      evidenceURI: update.evidenceURI,
      resultingSettings: [
        `Damping: ${formatFixed(update.proposed.dampingFp)}`,
        `Trusted-account multiplier: ${formatFixed(update.proposed.trustMultiplierFp)}`,
        `Trusted accounts: ${update.proposed.trustedSeeds.length}`,
        `Maximum iterations: ${update.proposed.maxIterations}`,
      ],
    }
  }

  if (action.data === '0x' && BigInt(action.value || '0') > 0n) {
    return {
      kind: 'transfer',
      title: `Send ${formatEther(BigInt(action.value))} ETH`,
      summary: action.description || 'Transfer ETH from the DAO treasury.',
      badge: 'Treasury transfer',
      icon: Send,
    }
  }

  return {
    kind: 'custom',
    title: action.description || 'Execute a contract call',
    summary: action.description
      ? 'Execute this custom contract call from the DAO.'
      : 'This action is not yet recognized by TrustGraph.',
    badge: action.operation === 1 ? 'Delegate call' : 'Contract call',
    icon: Code2,
  }
}

const formatOperation = (operation = 0) =>
  operation === 1 ? 'DELEGATECALL' : 'CALL'

function ProposalActionCard({
  action,
  index,
  total,
  diffLines,
}: {
  action: DisplayProposalAction
  index: number
  total: number
  diffLines: string[]
}) {
  const presentation = presentAction(action)
  const Icon = presentation.icon
  const value = BigInt(action.value || '0')
  const contractCall =
    action.contractName && action.functionSignature
      ? `${action.contractName}.${action.functionSignature}`
      : null

  return (
    <Card type="accent" size="md" className="min-w-0 space-y-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center border border-border bg-surface text-foreground">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="tg-label">
              Step {index + 1} of {total}
            </p>
            <span className="border border-border bg-surface px-2 py-1 text-xs text-muted-foreground">
              {presentation.badge}
            </span>
          </div>
          <h4 className="mt-2 text-base font-semibold text-foreground">
            {presentation.title}
          </h4>
          <p className="mt-1 text-sm text-muted-foreground">
            {presentation.summary}
          </p>
        </div>
      </div>

      {presentation.kind === 'scoring-update' && diffLines.length > 0 && (
        <div className="border-l-2 border-foreground/30 bg-surface px-3 py-2">
          <p className="text-xs font-medium text-foreground">
            Settings changed
          </p>
          <ul className="mt-2 space-y-1 text-sm text-foreground/80">
            {diffLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      {presentation.kind === 'scoring-update' &&
        diffLines.length === 0 &&
        presentation.resultingSettings && (
          <div className="border-l-2 border-foreground/30 bg-surface px-3 py-2">
            <p className="text-xs font-medium text-foreground">
              Resulting settings
            </p>
            <ul className="mt-2 grid gap-1 text-sm text-foreground/80 sm:grid-cols-2">
              {presentation.resultingSettings.map((setting) => (
                <li key={setting}>{setting}</li>
              ))}
            </ul>
          </div>
        )}

      {presentation.hash && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            {presentation.kind === 'signer-sync'
              ? 'Configuration to use'
              : 'New configuration ID'}
          </p>
          <CopyableText
            text={presentation.hash}
            truncate
            alwaysShowCopyIcon
            className="max-w-full text-foreground"
          />
        </div>
      )}

      {presentation.evidenceURI && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Supporting evidence</p>
          <CopyableText
            text={presentation.evidenceURI}
            truncate
            alwaysShowCopyIcon
            className="max-w-full"
          />
        </div>
      )}

      <details className="border-t border-border pt-1">
        <summary className="min-h-11 cursor-pointer py-3 text-xs font-medium text-muted-foreground hover:text-foreground">
          Technical transaction details
        </summary>
        <div className="space-y-3 border-t border-border pt-3 text-xs">
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-muted-foreground">
            <span>{formatOperation(action.operation)}</span>
            <span>{value === 0n ? '0 ETH' : `${formatEther(value)} ETH`}</span>
          </div>
          {contractCall && (
            <div className="space-y-1">
              <p className="text-muted-foreground">Contract function</p>
              <p className="break-words font-mono text-foreground">
                {contractCall}
              </p>
            </div>
          )}
          <div className="space-y-1">
            <p className="text-muted-foreground">Target contract</p>
            <CopyableText
              text={action.target}
              truncate
              alwaysShowCopyIcon
              className="max-w-full"
            />
          </div>
          {action.data !== '0x' && (
            <div className="space-y-2">
              <p className="text-muted-foreground">Encoded calldata</p>
              <CopyableText
                text={action.data}
                displayText="Copy full calldata"
                truncate={false}
                truncateOnMobile={false}
                alwaysShowCopyIcon
              />
              <p className="max-h-32 overflow-auto break-all font-mono text-muted-foreground">
                {action.data}
              </p>
            </div>
          )}
        </div>
      </details>
    </Card>
  )
}

export function ProposalActionList({
  actions,
  proposalDescription,
  className,
}: {
  actions: DisplayProposalAction[]
  proposalDescription?: string
  className?: string
}) {
  const presentations = actions.map(presentAction)
  const signer = presentations.find((action) => action.kind === 'signer-sync')
  const update = presentations.find(
    (action) => action.kind === 'scoring-update'
  )
  const coordinatedScoringUpdate =
    !!signer?.hash &&
    !!update?.hash &&
    signer.hash.toLowerCase() === update.hash.toLowerCase()
  const diffLines = proposalDiffLines(proposalDescription)

  return (
    <div className={cn('space-y-3', className)}>
      {coordinatedScoringUpdate && (
        <div className="border border-success/40 bg-success-soft p-4">
          <p className="text-sm font-medium text-foreground">
            One coordinated scoring update
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            These calls use the same configuration ID and execute together. The
            signer rules are synchronized and the complete settings are
            published as the next version.
          </p>
        </div>
      )}
      <ol className="space-y-3">
        {actions.map((action, index) => (
          <li key={`${action.target}:${index}`}>
            <ProposalActionCard
              action={action}
              index={index}
              total={actions.length}
              diffLines={diffLines}
            />
          </li>
        ))}
      </ol>
    </div>
  )
}
