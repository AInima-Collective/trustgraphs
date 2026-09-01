'use client'

import {
  Code2,
  FilePenLine,
  PauseCircle,
  Send,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react'
import type { ComponentType } from 'react'
import { formatEther, formatUnits, isAddressEqual, zeroAddress } from 'viem'

import { useNetwork } from '@/contexts/NetworkContext'
import {
  governanceActionContextFor,
  normalizeSafeActions,
  walkGovernanceActions,
} from '@/lib/actions'
import type {
  CompositionPolicyActionValues,
  ConstitutionalTransferActionValues,
  ContributionRoundActionValues,
  Erc20TransferActionValues,
  EthTransferActionValues,
  GovernanceCancelProposalActionValues,
  GovernanceDelayActionValues,
  GovernanceDelegateCallTargetActionValues,
  GovernanceQuorumActionValues,
  MatchedGovernanceAction,
  NetworkProfileActionValues,
  OperationalRoleActionValues,
  RewardDistributionActionValues,
  RewardsAllowlistActionValues,
  RewardsDistributorAllowanceActionValues,
  RewardsFeePercentageActionValues,
  RewardsFeeRecipientActionValues,
  RewardsPauseActionValues,
  SafeAction,
  SafeDisableModuleActionValues,
  SafeSwapOwnerActionValues,
  SafetyAddressActionValues,
  ScoringParamsActionValues,
  SignerParamsActionValues,
  SignerPauseActionValues,
  VaultPolicyActionValues,
  VaultWithdrawalExecuteActionValues,
  VaultWithdrawalRequestActionValues,
  WeightedPriorRotationActionValues,
} from '@/lib/actions'
import { paramsHash } from '@/lib/pagerank/encode'
import { formatFixed } from '@/lib/scoring-params'
import { cn } from '@/lib/utils'

import { Card } from './Card'
import { CopyableText } from './CopyableText'

export type DisplayProposalAction = SafeAction & {
  contractName?: string
  functionSignature?: string
}

type ActionKind =
  | 'signer-sync'
  | 'signer-pause'
  | 'scoring-update'
  | 'weighted-prior'
  | 'network-profile'
  | 'transfer'
  | 'treasury'
  | 'governance'
  | 'membership'
  | 'safety'
  | 'vault'
  | 'programs'
  | 'custom'

type ActionPresentation = {
  kind: ActionKind
  title: string
  summary: string
  badge: string
  icon: ComponentType<{ className?: string }>
  hash?: string
  evidenceURI?: string
  resultingSettings?: string[]
  coordinated?: boolean
  detailLabel?: string
  detailValue?: string
}

const presentAction = (
  matched: MatchedGovernanceAction
): ActionPresentation => {
  switch (matched.definition.key) {
    case 'update-scoring-params': {
      const values = matched.values as ScoringParamsActionValues
      return {
        kind: 'scoring-update',
        title: 'Publish the new scoring configuration',
        summary: values.syncSigner
          ? 'Synchronize signer selection and publish these settings together as the network’s next version.'
          : 'Make these settings the network’s current, versioned scoring configuration.',
        badge: 'Scoring settings',
        icon: SlidersHorizontal,
        hash: paramsHash(values.proposed),
        evidenceURI: values.evidenceURI,
        resultingSettings: [
          `Damping: ${formatFixed(values.proposed.dampingFp)}`,
          `Trusted accounts: ${values.proposed.trustedSeeds.length}`,
          `Maximum iterations: ${values.proposed.maxIterations}`,
        ],
        coordinated: values.syncSigner,
      }
    }
    case 'set-signer-params-hash': {
      const values = matched.values as SignerParamsActionValues
      return {
        kind: 'signer-sync',
        title: 'Synchronize signer rules',
        summary:
          'Point the signer-selection module at the new scoring configuration.',
        badge: 'Signer rules',
        icon: ShieldCheck,
        hash: values.paramsHash,
      }
    }
    case 'send-eth': {
      const values = matched.values as EthTransferActionValues
      return {
        kind: 'transfer',
        title: `Send ${formatEther(BigInt(values.value))} ETH`,
        summary: 'Transfer ETH from the DAO treasury.',
        badge: 'Treasury transfer',
        icon: Send,
      }
    }
    case 'send-erc20': {
      const values = matched.values as Erc20TransferActionValues
      return {
        kind: 'transfer',
        title: `Send ${values.amount} token base units`,
        summary: `Call transfer to ${values.recipient} on the explicitly shown token contract.`,
        badge: 'Treasury transfer',
        icon: Send,
        detailLabel: 'Token contract',
        detailValue: values.token,
      }
    }
    case 'fund-rewards': {
      const values = matched.values as RewardDistributionActionValues
      const asset = isAddressEqual(values.token, zeroAddress)
        ? 'native ETH wei'
        : 'token base units'
      return {
        kind: 'treasury',
        title: `Fund rewards with ${values.amount} ${asset}`,
        summary:
          'Create a reward pool bound to one exact proven score root and fee quote.',
        badge: 'Rewards funding',
        icon: Send,
        detailLabel: 'Expected score root',
        detailValue: values.expectedRoot,
        resultingSettings: [
          `Token: ${values.token}`,
          `Expected total score: ${values.expectedTotalMerkleValue}`,
          `Maximum fee: ${values.maxFeeAmount} base units`,
          `Claim deadline: ${values.claimDeadline === '0' ? 'No expiry' : values.claimDeadline}`,
          `Expected fee recipient: ${values.expectedFeeRecipient}`,
        ],
      }
    }
    case 'set-rewards-paused': {
      const values = matched.values as RewardsPauseActionValues
      return {
        kind: 'treasury',
        title: `${values.paused ? 'Pause' : 'Resume'} reward funding and claims`,
        summary: values.paused
          ? 'Stop new distributions and claims while preserving expired sweep access.'
          : 'Allow reward distributions and claims again.',
        badge: 'Rewards control',
        icon: PauseCircle,
      }
    }
    case 'set-rewards-fee-recipient': {
      const values = matched.values as RewardsFeeRecipientActionValues
      return {
        kind: 'treasury',
        title: 'Change the rewards fee recipient',
        summary: 'Route future distributor fees to a new address.',
        badge: 'Rewards control',
        icon: SlidersHorizontal,
        detailLabel: 'New fee recipient',
        detailValue: values.recipient,
      }
    }
    case 'set-rewards-fee-percentage': {
      const values = matched.values as RewardsFeePercentageActionValues
      return {
        kind: 'treasury',
        title: `Set rewards fee to ${formatUnits(BigInt(values.feePercentage), 16)}%`,
        summary:
          'A decrease applies immediately; an increase enters the distributor’s delayed schedule.',
        badge: 'Rewards control',
        icon: SlidersHorizontal,
      }
    }
    case 'set-rewards-allowlist-enabled': {
      const values = matched.values as RewardsAllowlistActionValues
      return {
        kind: 'treasury',
        title: `${values.enabled ? 'Enable' : 'Disable'} the rewards funder allowlist`,
        summary: values.enabled
          ? 'Only individually allowed addresses may create reward pools.'
          : 'Any address may create a reward pool.',
        badge: 'Rewards control',
        icon: ShieldCheck,
      }
    }
    case 'set-rewards-distributor-allowance': {
      const values = matched.values as RewardsDistributorAllowanceActionValues
      return {
        kind: 'treasury',
        title: `${values.allowed ? 'Allow' : 'Remove'} a rewards funder`,
        summary: values.allowed
          ? 'Permit this address to fund rewards while the allowlist is enabled.'
          : 'Remove this address from the rewards funder allowlist.',
        badge: 'Rewards control',
        icon: ShieldCheck,
        detailLabel: 'Funder address',
        detailValue: values.distributor,
      }
    }
    case 'update-network-profile': {
      const values = matched.values as NetworkProfileActionValues
      return {
        kind: 'network-profile',
        title: 'Publish a new network profile',
        summary:
          'Point the network snapshot at the reviewed metadata revision.',
        badge: 'Network profile',
        icon: FilePenLine,
        detailLabel: 'New metadata URI',
        detailValue: values.metadataURI,
      }
    }
    case 'set-operational-role': {
      const values = matched.values as OperationalRoleActionValues
      return {
        kind: 'membership',
        title: `${values.granted ? 'Grant' : 'Revoke'} operational role`,
        summary: values.granted
          ? 'Allow this account to publish operational parameter hashes.'
          : 'Remove this account’s operational parameter authority.',
        badge: 'Membership',
        icon: ShieldCheck,
        detailLabel: 'Account',
        detailValue: values.account,
      }
    }
    case 'propose-constitutional-transfer': {
      const values = matched.values as ConstitutionalTransferActionValues
      return {
        kind: 'membership',
        title: 'Propose a constitutional authority transfer',
        summary:
          'Begin a two-step handoff. Acceptance gives the successor constitutional control and removes this Safe’s role.',
        badge: 'Constitutional authority',
        icon: ShieldCheck,
        detailLabel: 'Proposed successor',
        detailValue: values.successor,
      }
    }
    case 'cancel-constitutional-transfer':
      return {
        kind: 'membership',
        title: 'Cancel the constitutional authority transfer',
        summary: 'Stop the snapshot’s currently pending two-step handoff.',
        badge: 'Constitutional authority',
        icon: ShieldCheck,
      }
    case 'set-governance-quorum': {
      const values = matched.values as GovernanceQuorumActionValues
      return {
        kind: 'governance',
        title: `Set quorum to ${formatUnits(BigInt(values.quorum), 16)}%`,
        summary:
          'Set the share of decisive voting power required for future proposals.',
        badge: 'Governance settings',
        icon: SlidersHorizontal,
      }
    }
    case 'set-governance-voting-delay':
    case 'set-governance-voting-period':
    case 'set-governance-execution-delay': {
      const values = matched.values as GovernanceDelayActionValues
      const labels = {
        'set-governance-voting-delay': 'voting delay',
        'set-governance-voting-period': 'voting period',
        'set-governance-execution-delay': 'execution delay',
      } as const
      const label = labels[matched.definition.key as keyof typeof labels]
      return {
        kind: 'governance',
        title: `Set ${label} to ${values.blocks} blocks`,
        summary: `Change the network’s ${label} for future proposals.`,
        badge: 'Governance settings',
        icon: SlidersHorizontal,
      }
    }
    case 'set-governance-delegatecall-target': {
      const values = matched.values as GovernanceDelegateCallTargetActionValues
      return {
        kind: 'governance',
        title: `${values.allowed ? 'Allow' : 'Revoke'} a delegatecall target`,
        summary: values.allowed
          ? 'Permit proposal code at this address to execute inside the Safe’s storage context.'
          : 'Prevent future proposals from delegatecalling this target.',
        badge: 'Execution safety',
        icon: ShieldCheck,
        detailLabel: 'Delegatecall target',
        detailValue: values.target,
      }
    }
    case 'cancel-governance-proposal': {
      const values = matched.values as GovernanceCancelProposalActionValues
      return {
        kind: 'governance',
        title: `Cancel governance proposal ${values.proposalId}`,
        summary: 'Mark the referenced, unexecuted proposal as cancelled.',
        badge: 'Governance control',
        icon: PauseCircle,
      }
    }
    case 'set-signer-sync-paused': {
      const values = matched.values as SignerPauseActionValues
      return {
        kind: 'signer-pause',
        title: `${values.paused ? 'Pause' : 'Resume'} signer synchronization`,
        summary: values.paused
          ? 'Stop new score-selected signer proofs while retaining the current Safe owners.'
          : 'Allow new score-selected signer proofs to update the Safe owners again.',
        badge: 'Safety control',
        icon: PauseCircle,
      }
    }
    case 'rotate-weighted-prior': {
      const values = matched.values as WeightedPriorRotationActionValues
      return {
        kind: 'weighted-prior',
        title: 'Change weighted starting shares',
        summary:
          'Propose a reviewed weighted-prior manifest for delayed activation.',
        badge: 'Scoring settings',
        icon: SlidersHorizontal,
        detailLabel: 'Manifest metadata digest',
        detailValue: values.metadataDigest,
      }
    }
    case 'cancel-weighted-prior':
      return {
        kind: 'weighted-prior',
        title: 'Cancel pending weighted starting shares',
        summary: 'Stop the controller’s pending weighted-prior version.',
        badge: 'Scoring settings',
        icon: PauseCircle,
      }
    case 'propose-composition-policy': {
      const values = matched.values as CompositionPolicyActionValues
      return {
        kind: 'scoring-update',
        title: 'Change composition source policy',
        summary:
          'Propose reviewed source weights and adapters for delayed activation.',
        badge: 'Composition policy',
        icon: SlidersHorizontal,
        detailLabel: 'Metadata digest',
        detailValue: values.metadataDigest,
        resultingSettings: [`Source adapters: ${values.adapters.length}`],
      }
    }
    case 'cancel-composition-policy':
      return {
        kind: 'scoring-update',
        title: 'Cancel pending composition policy',
        summary: 'Stop the controller’s currently pending source policy.',
        badge: 'Composition policy',
        icon: PauseCircle,
      }
    case 'set-snapshot-verifier':
    case 'set-snapshot-accumulator':
    case 'set-snapshot-anchor-registry':
    case 'enable-safe-module':
    case 'set-safe-guard': {
      const values = matched.values as SafetyAddressActionValues
      const labels = {
        'set-snapshot-verifier': ['Replace the proof verifier', 'New verifier'],
        'set-snapshot-accumulator': [
          'Replace the attestation accumulator',
          'New accumulator',
        ],
        'set-snapshot-anchor-registry': [
          'Replace the anchor registry',
          'New registry',
        ],
        'enable-safe-module': ['Enable a Safe module', 'Module'],
        'set-safe-guard': ['Replace the Safe guard', 'New guard'],
      } as const
      const [title, detailLabel] =
        labels[matched.definition.key as keyof typeof labels]
      return {
        kind: 'safety',
        title,
        summary:
          'This changes a proof or Safe execution boundary. Review the exact address carefully.',
        badge: 'Safety control',
        icon: ShieldCheck,
        detailLabel,
        detailValue: values.address,
      }
    }
    case 'disable-safe-module': {
      const values = matched.values as SafeDisableModuleActionValues
      return {
        kind: 'safety',
        title: 'Disable a Safe module',
        summary: 'Remove this module’s authority to execute Safe transactions.',
        badge: 'Safety control',
        icon: ShieldCheck,
        detailLabel: 'Module',
        detailValue: values.module,
      }
    }
    case 'swap-safe-owner': {
      const values = matched.values as SafeSwapOwnerActionValues
      return {
        kind: 'safety',
        title: 'Replace a Safe owner',
        summary: `Replace ${values.oldOwner} with the new owner shown below.`,
        badge: 'Safety control',
        icon: ShieldCheck,
        detailLabel: 'New owner',
        detailValue: values.newOwner,
      }
    }
    case 'set-vault-policy': {
      const values = matched.values as VaultPolicyActionValues
      return {
        kind: 'vault',
        title: 'Update proving-vault payout policy',
        summary:
          'Change when and how much successful score proofs may be paid.',
        badge: 'Proving vault',
        icon: SlidersHorizontal,
        resultingSettings: [
          `Minimum paid interval: ${values.minPaidIntervalBlocks} blocks`,
          `Maximum per root: ${values.maxPerRootUsd} USD × 1e8`,
        ],
      }
    }
    case 'request-vault-withdrawal': {
      const values = matched.values as VaultWithdrawalRequestActionValues
      return {
        kind: 'vault',
        title: 'Request proving-fund withdrawal',
        summary:
          'Start the withdrawal notice period while funds remain available for bounties.',
        badge: 'Proving vault',
        icon: Send,
        resultingSettings: [
          `ETH: ${values.ethAmount} wei`,
          `USDC: ${values.usdcAmount} base units`,
        ],
      }
    }
    case 'cancel-vault-withdrawal':
      return {
        kind: 'vault',
        title: 'Cancel proving-fund withdrawal',
        summary: 'Keep the pending funds working for future score proofs.',
        badge: 'Proving vault',
        icon: PauseCircle,
      }
    case 'execute-vault-withdrawal': {
      const values = matched.values as VaultWithdrawalExecuteActionValues
      return {
        kind: 'vault',
        title: 'Execute proving-fund withdrawal',
        summary: 'Send the remaining requested funds after the notice period.',
        badge: 'Proving vault',
        icon: Send,
        detailLabel: 'Recipient',
        detailValue: values.recipient,
      }
    }
    case 'create-contribution-round': {
      const values = matched.values as ContributionRoundActionValues
      return {
        kind: 'programs',
        title: `Create contribution round “${values.name}”`,
        summary:
          'Create a child funding round attached to this authenticated parent network.',
        badge: 'Contribution program',
        icon: FilePenLine,
        resultingSettings: [
          `Window: ${values.roundStart}–${values.roundEnd}`,
          `Pool shares: ${values.totalPool}`,
          `Rater reward: ${values.evaluatorCarveoutBps} bps`,
          `Payout token: ${values.distributorToken}`,
        ],
      }
    }
    default: {
      const action = matched.actions[0]
      return {
        kind: 'custom',
        title: 'Execute a contract call',
        summary:
          'This action is not recognized by trustgraphs. Review its raw target, value, operation, and calldata.',
        badge: action?.operation === 1 ? 'Delegate call' : 'Contract call',
        icon: Code2,
      }
    }
  }
}

const formatOperation = (operation: SafeAction['operation']) =>
  operation === 1 ? 'DELEGATECALL' : 'CALL'

const actionValue = (value: string) => {
  try {
    return BigInt(value)
  } catch {
    return 0n
  }
}

function TechnicalActionDetails({
  actions,
}: {
  actions: readonly DisplayProposalAction[]
}) {
  return (
    <details className="border-t border-border pt-1">
      <summary className="min-h-11 cursor-pointer py-3 text-xs font-medium text-muted-foreground hover:text-foreground">
        Technical transaction details
      </summary>
      <div className="space-y-4 border-t border-border pt-3 text-xs">
        {actions.map((action, index) => {
          const value = actionValue(action.value)
          const contractCall =
            action.contractName && action.functionSignature
              ? `${action.contractName}.${action.functionSignature}`
              : null
          return (
            <div
              key={`${action.target}:${index}`}
              className="space-y-3 border-b border-border pb-4 last:border-0 last:pb-0"
            >
              {actions.length > 1 && (
                <p className="font-medium text-foreground">
                  Transaction {index + 1} of {actions.length}
                </p>
              )}
              <div className="flex flex-wrap gap-x-5 gap-y-2 text-muted-foreground">
                <span>{formatOperation(action.operation)}</span>
                <span>
                  {value === 0n ? '0 ETH' : `${formatEther(value)} ETH`}
                </span>
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
          )
        })}
      </div>
    </details>
  )
}

function ProposalActionCard({
  matched,
  actions,
  index,
  total,
}: {
  matched: MatchedGovernanceAction
  actions: readonly DisplayProposalAction[]
  index: number
  total: number
}) {
  const presentation = presentAction(matched)
  const Icon = presentation.icon
  const annotations = actions
    .map((action) => action.description?.trim())
    .filter((description): description is string => !!description)

  return (
    <Card
      type="accent"
      size="md"
      className={cn(
        'min-w-0 space-y-4',
        matched.definition.danger && 'border-destructive/60'
      )}
    >
      {matched.definition.danger && (
        <div className="border border-destructive/50 bg-destructive/10 p-3 text-xs">
          <p className="font-medium text-foreground">
            High-impact governance action
          </p>
          <p className="mt-1 text-muted-foreground">
            This changes an authority or execution safety boundary. Verify the
            decoded target and outcome carefully.
          </p>
        </div>
      )}
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center border border-border bg-surface text-foreground">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="tg-label">
              Action {index + 1} of {total}
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

      {presentation.resultingSettings && (
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

      {presentation.detailValue && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            {presentation.detailLabel}
          </p>
          <CopyableText
            text={presentation.detailValue}
            truncate
            alwaysShowCopyIcon
            className="max-w-full"
          />
        </div>
      )}

      {annotations.length > 0 && (
        <div className="border border-border bg-surface-2 px-3 py-2">
          <p className="text-xs font-medium text-foreground">
            Proposer annotation
          </p>
          {annotations.map((annotation, annotationIndex) => (
            <p
              key={`${annotation}:${annotationIndex}`}
              className="mt-1 break-words text-xs text-muted-foreground"
            >
              {annotation}
            </p>
          ))}
        </div>
      )}

      <TechnicalActionDetails actions={actions} />
    </Card>
  )
}

export function ProposalActionList({
  actions,
  className,
}: {
  actions: readonly DisplayProposalAction[]
  className?: string
}) {
  const { network } = useNetwork()
  const normalized = normalizeSafeActions(actions)
  if (!normalized.ok) {
    return (
      <div
        className={cn(
          'border border-destructive/50 bg-destructive/10 p-4 text-sm',
          className
        )}
        role="alert"
      >
        <p className="font-medium text-foreground">
          Action details unavailable
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {normalized.reason} No transaction details were inferred from the
          malformed payload.
        </p>
      </div>
    )
  }
  const displayActions = normalized.actions.map((action, index) => ({
    ...action,
    ...(actions[index]?.contractName
      ? { contractName: actions[index].contractName }
      : {}),
    ...(actions[index]?.functionSignature
      ? { functionSignature: actions[index].functionSignature }
      : {}),
  }))
  const context = governanceActionContextFor(network)
  const matched = walkGovernanceActions(displayActions, context)
  const coordinatedScoringUpdate = matched.some(
    (entry) => presentAction(entry).coordinated
  )

  return (
    <div className={cn('space-y-3', className)}>
      {coordinatedScoringUpdate && (
        <div className="border border-success/40 bg-success-soft p-4">
          <p className="text-sm font-medium text-foreground">
            One coordinated scoring update
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            These consecutive calls use the same configuration ID and execute
            together. The signer rules are synchronized before the complete
            settings are published as the next version.
          </p>
        </div>
      )}
      <ol className="space-y-3">
        {matched.map((entry, index) => (
          <li key={`${entry.definition.key}:${entry.startIndex}`}>
            <ProposalActionCard
              matched={entry}
              actions={displayActions.slice(
                entry.startIndex,
                entry.startIndex + entry.consumed
              )}
              index={index}
              total={matched.length}
            />
          </li>
        ))}
      </ol>
    </div>
  )
}
