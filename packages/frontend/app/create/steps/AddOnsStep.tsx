'use client'

import { erc20Abi, isAddress } from 'viem'
import { useReadContracts } from 'wagmi'

import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { Input } from '@/components/Input'
import { Switch } from '@/components/Switch'
import { useAuthorityProfile } from '@/hooks/useAuthorityProfile'
import { cn } from '@/lib/utils'

import {
  GOVERNED_FACTORY_ADDRESS,
  MAX_OFFCHAIN_TOTAL_INPUTS,
  WizardData,
  describeBlocks,
  effectiveBlocks,
  fundTokenProblem,
  isOffchainVouchCreationAvailable,
  isSignerSyncAvailable,
  offchainVouchesProblem,
  prepayProblem,
  signerSyncProblem,
} from '../model'
import { Field, Note, StepHeader } from '../ui'

export const AddOnsStep = ({
  data,
  onChange,
  showErrors,
  epochFloor,
}: {
  data: WizardData
  onChange: (patch: Partial<WizardData>) => void
  showErrors: boolean
  epochFloor: bigint
}) => {
  const tokenAddress = data.fundTokenAddress.trim()
  const tokenLooksValid = isAddress(tokenAddress, { strict: false })

  const { data: tokenInfo } = useReadContracts({
    contracts: tokenLooksValid
      ? [
          {
            address: tokenAddress as `0x${string}`,
            abi: erc20Abi,
            functionName: 'symbol',
          },
          {
            address: tokenAddress as `0x${string}`,
            abi: erc20Abi,
            functionName: 'decimals',
          },
        ]
      : [],
    query: {
      enabled: data.withFund && data.fundToken === 'other' && tokenLooksValid,
    },
  })

  const symbol = tokenInfo?.[0]?.result as string | undefined
  const lookupFailed =
    tokenLooksValid && tokenInfo && tokenInfo[0]?.status === 'failure'

  const tokenError = showErrors ? fundTokenProblem(data) : null
  const prepayError = showErrors ? prepayProblem(data) : null
  const signerSyncError = showErrors ? signerSyncProblem(data) : null
  const offchainError = showErrors ? offchainVouchesProblem(data) : null
  const signerSyncAvailable = isSignerSyncAvailable()
  const offchainAvailable = isOffchainVouchCreationAvailable()
  const paidCadence = effectiveBlocks(data.tuning.cadence, epochFloor)
  // The live governance profile the review screen also reads; stated here so nobody reaches the
  // last step before learning a Safe is part of the deal.
  const authority = useAuthorityProfile(GOVERNED_FACTORY_ADDRESS)

  return (
    <div className="space-y-6">
      <StepHeader
        title="Add a shared fund?"
        lead="A shared fund lets your community put money in one place and split it by trust score. Anyone can top it up, and each member claims their own share."
      />

      <Card type="outline" size="md">
        <div className="flex flex-row items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm">Add a shared fund</div>
            <p className="text-xs text-muted-foreground max-w-xl">
              Skip this if your community only wants scores. Nothing else
              changes either way.
            </p>
          </div>
          <Switch
            size="md"
            enabled={data.withFund}
            onClick={() => onChange({ withFund: !data.withFund })}
          />
        </div>
      </Card>

      {/* Not an option, a statement: every wizard creation installs governance, and the person
          deciding on extras should learn that here, not on the review screen. */}
      <Card type="detail" size="md" className="space-y-2">
        <div className="text-sm">Governance comes included</div>
        <p className="text-xs text-muted-foreground max-w-xl">
          Every network created here starts governed; there is no toggle. The
          same transaction creates a DAO Safe, a shared onchain account that
          owns the network and its fund. Your wallet becomes the Safe&apos;s
          only recorded owner, but a permanently sealed guard disables
          owner-signed transactions: members direct the Safe through delayed
          trust-weighted voting, and your wallet keeps a slow, visible recovery
          role.
        </p>
        <p className="text-xs text-muted-foreground max-w-xl">
          {authority.valid
            ? `Read live from the factory: ${describeBlocks(
                authority.memberVotingDelay ?? 0n
              )} before voting starts, ${describeBlocks(
                authority.memberVotingPeriod ?? 0n
              )} to vote, ${describeBlocks(
                authority.memberExecutionDelay ?? 0n
              )} before the Safe executes a passed proposal, and a ${
                Number(authority.recoveryDelay ?? 0n) / 86_400
              }-day recovery delay.`
            : authority.loading
              ? 'Reading the live voting profile from the factory…'
              : 'The live voting profile could not be read. The review step blocks creation until the factory exposes it.'}
        </p>
      </Card>

      <Card type="detail" size="md" className="space-y-3">
        <div className="flex flex-row items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm">Gasless off-chain vouches</div>
            <p className="text-xs text-muted-foreground max-w-xl">
              Let members sign EAS v2 vouches without paying an attestation
              transaction. Public relayers retain the exact signed log, pin it
              to independent storage, and pay to anchor its content hash.
              On-chain vouches continue to work alongside it.
            </p>
          </div>
          <Switch
            size="md"
            enabled={data.withOffchainVouches}
            readOnly={!offchainAvailable}
            onClick={() =>
              offchainAvailable &&
              onChange({
                withOffchainVouches: !data.withOffchainVouches,
                // The hybrid guest is not a valid signer-selection input.
                ...(!data.withOffchainVouches ? { withSignerSync: false } : {}),
              })
            }
          />
        </div>

        {!offchainAvailable && (
          <Note>
            This deployment has not published the required two or more initial
            relayer addresses, so strict off-chain vouches cannot be created
            here yet.
          </Note>
        )}

        {data.withOffchainVouches && (
          <div className="space-y-2 border-t border-border pt-3">
            <Field label="Immutable proof-work cap" error={offchainError}>
              <div className="flex items-center gap-2">
                <input
                  className="w-40 rounded border border-border bg-transparent px-2 py-1 text-sm"
                  type="number"
                  min={1}
                  max={MAX_OFFCHAIN_TOTAL_INPUTS}
                  step={1}
                  value={data.offchainMaxTotalInputs}
                  onChange={(event) =>
                    onChange({
                      offchainMaxTotalInputs: Number(event.target.value),
                    })
                  }
                />
                <span className="text-xs text-muted-foreground">
                  work units
                </span>
              </div>
            </Field>
            <p className="text-xs text-muted-foreground max-w-xl">
              This one ceiling covers on-chain leaves, anchor records, and
              retained off-chain log entries. It can never be raised after
              creation. Each off-chain entry consumes four units and each anchor
              consumes one; the protocol ceiling is{' '}
              {MAX_OFFCHAIN_TOTAL_INPUTS.toLocaleString()}.
            </p>
            <Note tone="warning">
              This lane currently supports EOAs only. Score-selected Safe
              signers and contribution rounds are unavailable because their
              guests do not authenticate the strict lane. Weighted and composed
              creation remain separate network types.
            </Note>
          </div>
        )}
      </Card>

      <Card type="detail" size="md">
        <div className="flex flex-row items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm">Keep Safe signers aligned with scores</div>
            <p className="text-xs text-muted-foreground max-w-xl">
              Install a separate zero-knowledge module that periodically makes
              the highest-scoring, recently active accounts the Safe&apos;s
              recorded signers. Activity means casting your own authenticated
              governance vote—not a heartbeat or a delegated vote. The sealed
              guard still prevents owner-signed execution; member voting remains
              the authority for transactions.
            </p>
          </div>
          <Switch
            size="md"
            enabled={data.withSignerSync}
            readOnly={!signerSyncAvailable || data.withOffchainVouches}
            onClick={() =>
              signerSyncAvailable &&
              !data.withOffchainVouches &&
              onChange({ withSignerSync: !data.withSignerSync })
            }
          />
        </div>

        {!signerSyncAvailable && (
          <Note>
            This deployment has not published a signer verifier and program
            identity, so the optional module cannot be installed here.
          </Note>
        )}

        {data.withOffchainVouches && (
          <Note>
            Disabled for this hybrid network: the signer-selection guest does
            not authenticate strict off-chain history.
          </Note>
        )}

        {data.withSignerSync && (
          <div className="mt-4 grid gap-4 border-t border-border pt-4 sm:grid-cols-3">
            <Field label="Top signers" error={signerSyncError}>
              <input
                className="w-full rounded border border-border bg-transparent px-2 py-1 text-sm"
                type="number"
                min={2}
                max={64}
                value={data.signerTopN}
                onChange={(event) =>
                  onChange({ signerTopN: Number(event.target.value) })
                }
              />
            </Field>
            <Field label="Minimum threshold">
              <input
                className="w-full rounded border border-border bg-transparent px-2 py-1 text-sm"
                type="number"
                min={2}
                max={data.signerTopN}
                value={data.signerMinThreshold}
                onChange={(event) =>
                  onChange({ signerMinThreshold: Number(event.target.value) })
                }
              />
            </Field>
            <Field label="Target threshold">
              <div className="flex items-center gap-2">
                <input
                  className="w-full rounded border border-border bg-transparent px-2 py-1 text-sm"
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  value={data.signerTargetThresholdPct}
                  onChange={(event) =>
                    onChange({
                      signerTargetThresholdPct: Number(event.target.value),
                    })
                  }
                />
                <span className="text-sm opacity-60">%</span>
              </div>
            </Field>
            <p className="text-xs text-muted-foreground sm:col-span-3">
              Each proven score checkpoint selects up to {data.signerTopN}{' '}
              accounts. The Safe threshold targets{' '}
              {data.signerTargetThresholdPct}% and never falls below{' '}
              {data.signerMinThreshold}.
            </p>
            <p className="text-xs text-muted-foreground sm:col-span-3">
              Missing activity never removes anyone. Rotation starts only after
              two distinct fresh witnesses; after the first rotation, both must
              be current owners. This lets two live owners replace three inactive
              owners without letting one account activate removals alone.
            </p>
          </div>
        )}
      </Card>

      {/* The proving tank. Deliberately its own card rather than a sub-option of the fund: the
          two are unrelated, and burying it would leave creators discovering the funding step
          after their first month of scores went stale. */}
      <Card type="detail" size="md">
        <Field
          label="Pay for score refreshes up front?"
          hint="Scores only refresh if somebody does the work, and that costs gas and proving time. Put ETH in during creation to fund the first refreshes; you can top up later in network settings. Withdrawing unused ETH is not available in this app; a constitutional administrator must request and execute it directly through ProvingVault, separated by the vault's withdrawal notice period."
          error={prepayError}
        >
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <input
                className="w-32 rounded border border-border bg-transparent px-2 py-1 text-sm"
                inputMode="decimal"
                placeholder="0.5"
                value={data.prepayEth}
                onChange={(e) => onChange({ prepayEth: e.target.value })}
              />
              <span className="text-sm opacity-60">ETH (optional)</span>
            </div>

            {data.prepayEth.trim() && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">
                    Maximum per refresh
                  </label>
                  <div className="flex items-center gap-2">
                    <span className="text-sm opacity-60">$</span>
                    <input
                      className="w-32 rounded border border-border bg-transparent px-2 py-1 text-sm"
                      inputMode="decimal"
                      value={data.maxPerRootUsd}
                      onChange={(e) =>
                        onChange({ maxPerRootUsd: e.target.value })
                      }
                    />
                    <span className="text-sm opacity-60">USD</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Covers the proving fee and gas together; creation is capped
                    at $10,000.
                  </p>
                </div>
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">
                    Paid no more often than
                  </div>
                  <div className="text-sm">{describeBlocks(paidCadence)}</div>
                  <p className="text-xs text-muted-foreground">
                    This starts equal to the score schedule. Your DAO Safe can
                    change it later.
                  </p>
                </div>
              </div>
            )}
          </div>
        </Field>
        {data.prepayEth.trim() && (
          <Note>
            Before signing, the app checks that this chain has priced its
            initial proving band and that your cap covers that fee. Creation is
            atomic: the ETH and payable policy either both land or neither does.
          </Note>
        )}
      </Card>

      {data.withFund && (
        <div className="space-y-6 border-l border-border pl-4 sm:pl-6">
          <Field
            label="What do you expect to pay out?"
            hint="This only decides what your payout screen shows first. The fund holds anything, and you can pay out something else whenever you like."
            error={tokenError}
          >
            <div className="flex flex-row flex-wrap gap-2">
              <Button
                type="button"
                variant={data.fundToken === 'eth' ? 'default' : 'outline'}
                size="sm"
                onClick={() => onChange({ fundToken: 'eth' })}
              >
                ETH
              </Button>
              <Button
                type="button"
                variant={data.fundToken === 'other' ? 'default' : 'outline'}
                size="sm"
                onClick={() => onChange({ fundToken: 'other' })}
              >
                Another token
              </Button>
            </div>
          </Field>

          {data.fundToken === 'other' && (
            <Field
              label="Token address"
              htmlFor="fund-token"
              hint={
                symbol
                  ? `Found ${symbol}.`
                  : lookupFailed
                    ? "We couldn't read a token at that address. Double check it, or carry on: this field is only a label."
                    : 'Paste the contract address of the token, for example a stablecoin your community already uses.'
              }
            >
              <Input
                id="fund-token"
                value={data.fundTokenAddress}
                placeholder="0x..."
                className={cn('max-w-md', symbol && 'border-primary')}
                onChange={(e) => onChange({ fundTokenAddress: e.target.value })}
              />
            </Field>
          )}

          <Note>
            You own the fund. Money only moves when you send a payout, and each
            member claims their share themselves.
          </Note>
        </div>
      )}

      {!data.withFund && (
        <Note>
          Skipping the fund closes no doors: a network created without one can
          attach a fund later from its settings page, under Features. The
          network&apos;s authority (the DAO Safe) must own the attached fund, so
          for a governed network that later step is a proposal.
        </Note>
      )}

      <Note>
        Looking for contribution rounds, where members submit work and rate each
        other for a shared pool? They are not a creation-time choice: a round
        needs a live network to hang from. Once your network exists, its
        authority starts a round from the network&apos;s settings page, under
        Features.
      </Note>
    </div>
  )
}
