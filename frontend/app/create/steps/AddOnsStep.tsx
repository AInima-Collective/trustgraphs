'use client'

import { erc20Abi, isAddress } from 'viem'
import { useReadContracts } from 'wagmi'

import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { Input } from '@/components/Input'
import { Switch } from '@/components/Switch'
import { cn } from '@/lib/utils'

import {
  WizardData,
  describeBlocks,
  effectiveBlocks,
  fundTokenProblem,
  prepayProblem,
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
  const paidCadence = effectiveBlocks(data.tuning.cadence, epochFloor)

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
          A fund can only be included while the network is being created. Adding
          one afterwards means deploying it separately, so turn it on now if you
          think you will want it.
        </Note>
      )}
    </div>
  )
}
