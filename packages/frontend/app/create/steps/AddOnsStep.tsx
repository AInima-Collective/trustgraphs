'use client'

import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
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
  WizardData,
  describeBlocks,
  fundTokenProblem,
  isSignerSyncAvailable,
  signerSyncProblem,
} from '../model'
import { Field, Note, StepHeader } from '../ui'

export const AddOnsStep = ({
  data,
  onChange,
  showErrors,
}: {
  data: WizardData
  onChange: (patch: Partial<WizardData>) => void
  showErrors: boolean
}) => {
  const [advancedOpen, setAdvancedOpen] = useState(false)
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
  const signerSyncError = showErrors ? signerSyncProblem(data) : null
  const signerSyncAvailable = isSignerSyncAvailable()
  const authority = useAuthorityProfile(GOVERNED_FACTORY_ADDRESS)

  return (
    <div className="space-y-6">
      <StepHeader
        title="Governance and extras"
        lead="Your network will be governed by its members. Choose whether it also needs a shared fund or any optional modules."
      />

      <Card type="detail" size="md" className="space-y-2">
        <div className="text-sm font-medium">Member governance is included</div>
        <p className="text-xs text-muted-foreground max-w-xl">
          A DAO Safe owns every network created here. Members direct it through
          delayed, trust-weighted voting. Your wallet cannot execute Safe
          transactions directly; it retains a delayed recovery role.
        </p>
        <p className="text-xs text-muted-foreground max-w-xl">
          {authority.valid
            ? `The current rules allow ${describeBlocks(
                authority.memberVotingDelay ?? 0n
              )} before voting, ${describeBlocks(
                authority.memberVotingPeriod ?? 0n
              )} to vote, and ${describeBlocks(
                authority.memberExecutionDelay ?? 0n
              )} before execution. Recovery has a ${
                Number(authority.recoveryDelay ?? 0n) / 86_400
              }-day delay.`
            : authority.loading
              ? 'Reading the governance rules…'
              : 'The governance rules could not be read. Creation will remain disabled until they are available.'}
        </p>
      </Card>

      <Card type="outline" size="md">
        <div className="flex flex-row items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm">Add a shared fund</div>
            <p className="text-xs text-muted-foreground max-w-xl">
              Hold community assets in the network&apos;s Safe and let members
              claim payouts allocated by trust score.
            </p>
          </div>
          <Switch
            size="md"
            enabled={data.withFund}
            onClick={() => onChange({ withFund: !data.withFund })}
          />
        </div>
      </Card>

      {data.withFund ? (
        <div className="space-y-6 border-l border-border pl-4 sm:pl-6">
          <Field
            label="Default payout asset"
            hint="This only chooses what the payout screen shows first. The fund can hold and distribute other assets later."
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
                    ? "We couldn't read a token at that address. Double-check it, or continue: this field only sets the default payout asset."
                    : 'Paste the contract address for the token your community expects to distribute.'
              }
            >
              <Input
                id="fund-token"
                value={data.fundTokenAddress}
                placeholder="0x..."
                className={cn('max-w-md', symbol && 'border-primary')}
                onChange={(event) =>
                  onChange({ fundTokenAddress: event.target.value })
                }
              />
            </Field>
          )}
        </div>
      ) : (
        <Note>
          You can add a shared fund later from network settings through a
          governance proposal.
        </Note>
      )}

      <Card type="detail" size="md">
        <div className="flex flex-row items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm">Gasless off-chain vouches</div>
              <span className="border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                Coming soon
              </span>
            </div>
            <p className="text-xs text-muted-foreground max-w-xl">
              Members will be able to sign vouches without paying gas. New
              networks currently use on-chain EAS vouches.
            </p>
          </div>
          <Switch size="md" enabled={false} readOnly />
        </div>
      </Card>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="px-0 hover:bg-transparent"
        onClick={() => setAdvancedOpen(!advancedOpen)}
      >
        {advancedOpen ? (
          <ChevronDown className="h-4 w-4" />
        ) : (
          <ChevronRight className="h-4 w-4" />
        )}
        Advanced settings
        {!advancedOpen && data.withSignerSync && (
          <span className="text-xs text-muted-foreground">(configured)</span>
        )}
      </Button>

      {advancedOpen && (
        <div className="border-l border-border pl-4 sm:pl-6">
          <Card type="detail" size="md">
            <div className="flex flex-row items-start justify-between gap-4">
              <div className="space-y-1">
                <div className="text-sm">
                  Keep Safe signers aligned with scores
                </div>
                <p className="text-xs text-muted-foreground max-w-xl">
                  Periodically update the Safe&apos;s recorded signers to the
                  highest-scoring accounts that recently cast their own
                  governance vote. Member voting remains the authority for Safe
                  transactions.
                </p>
              </div>
              <Switch
                size="md"
                enabled={data.withSignerSync}
                readOnly={!signerSyncAvailable}
                onClick={() =>
                  signerSyncAvailable &&
                  onChange({ withSignerSync: !data.withSignerSync })
                }
              />
            </div>

            {!signerSyncAvailable && (
              <Note className="mt-3">
                This deployment has not published the verifier required for
                signer sync.
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
                      onChange({
                        signerMinThreshold: Number(event.target.value),
                      })
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
                  Each proven checkpoint selects up to {data.signerTopN}{' '}
                  accounts. The Safe threshold targets{' '}
                  {data.signerTargetThresholdPct}% and never falls below{' '}
                  {data.signerMinThreshold}.
                </p>
              </div>
            )}
          </Card>
        </div>
      )}

      <Note>
        Contribution rounds can be added after creation from network settings.
      </Note>
    </div>
  )
}
