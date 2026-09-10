import type { GovernanceComposerActionKey } from './composer'

/**
 * One plain sentence per high-impact action saying what changes if it executes, shown on the
 * review step where the proposer has to acknowledge it.
 */
export const governanceDangerConsequences: Partial<
  Record<GovernanceComposerActionKey, string>
> = {
  'cancel-weighted-prior':
    'The pending weighted starting shares will never activate.',
  'cancel-composition-policy':
    'The pending composition policy will never activate.',
  'propose-constitutional-transfer':
    'Once the successor accepts, this Safe loses constitutional authority over the network.',
  'cancel-constitutional-transfer':
    'The proposed successor can no longer accept the handoff.',
  'set-governance-delegatecall-target':
    'Allowed delegatecall code runs inside the Safe’s own storage and bypasses its guard.',
  'cancel-governance-proposal':
    'The referenced proposal can never be executed, whatever its vote.',
  'set-snapshot-verifier':
    'A different verifier decides which score proofs the network accepts.',
  'set-snapshot-accumulator':
    'A different accumulator defines which inputs count as authenticated.',
  'set-snapshot-anchor-registry':
    'A different registry defines which anchored inputs the network trusts.',
  'enable-safe-module':
    'The module can execute transactions from the treasury without any signatures.',
  'disable-safe-module':
    'The module loses its authority. Disabling the governance module stops proposals from executing.',
  'set-safe-guard':
    'The guard checks every Safe transaction; replacing or clearing it changes what can execute at all.',
  'swap-safe-owner':
    'Safe ownership changes outside the signer-sync proof, and the next proof may change it again.',
  'set-recovery-proposer':
    'A different identity can queue delayed recovery actions against the treasury.',
  'cancel-recovery-action': 'The queued recovery action can never execute.',
  'request-vault-withdrawal':
    'After the notice period, the requested proving funds can leave the vault.',
  'execute-vault-withdrawal':
    'The requested proving funds leave the vault now.',
}

export const governanceDangerConsequence = (
  key: GovernanceComposerActionKey,
  fallback: string
) => governanceDangerConsequences[key] ?? fallback
