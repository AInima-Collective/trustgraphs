'use client'

import { ChevronDown, ChevronRight } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'

import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { Input } from '@/components/Input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/Select'

import {
  CADENCE_OPTIONS,
  Cadence,
  DEFAULT_TUNING,
  Tuning,
  WizardData,
  describeBlocks,
  effectiveBlocks,
  prepayProblem,
  requestedBlocks,
} from '../model'
import { Field, Note, PercentSetting, StepHeader } from '../ui'

export const TuningStep = ({
  data,
  onChange,
  epochFloor,
  showErrors,
  vaultAvailable,
}: {
  data: WizardData
  onChange: (patch: Partial<WizardData>) => void
  epochFloor: bigint
  showErrors: boolean
  vaultAvailable: boolean
}) => {
  const [open, setOpen] = useState(false)
  const tuning = data.tuning
  const setTuning = (patch: Partial<Tuning>) =>
    onChange({ tuning: { ...tuning, ...patch } })

  const requested = requestedBlocks(tuning.cadence, epochFloor)
  const effective = effectiveBlocks(tuning.cadence, epochFloor)
  const raised = requested < effective
  const prepayError = showErrors ? prepayProblem(data) : null

  const advancedKeys: (keyof Tuning)[] = [
    'headStartPct',
    'headStartKeptPct',
    'totalPoints',
  ]
  const advancedChanged = advancedKeys.filter(
    (key) => tuning[key] !== DEFAULT_TUNING[key]
  )

  return (
    <div className="space-y-6">
      <StepHeader
        title="Set up scoring"
        lead="Choose how strongly vouches shape scores and how often the scoreboard can be refreshed."
      />

      <Field
        label="How often scores can be recalculated"
        hint="New vouches appear immediately, but scores change only after someone publishes a new proof. Faster schedules respond sooner and cost more to maintain."
      >
        <Select
          value={tuning.cadence}
          onValueChange={(value) => setTuning({ cadence: value as Cadence })}
        >
          <SelectTrigger className="max-w-md">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CADENCE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {raised && (
        <Note tone="warning">
          This chain limits score updates to {describeBlocks(effective)}, so
          that is the schedule your network will use.
        </Note>
      )}

      <PercentSetting
        label="How much scores lean on vouches"
        value={tuning.vouchWeightPct}
        min={1}
        max={99}
        onChange={(value) => setTuning({ vouchWeightPct: value })}
        description="Higher values make the network's vouches more influential. Lower values keep scores closer to the starting accounts."
      />

      {vaultAvailable && (
        <Card type="outline" size="md">
          <Field
            label="Pay for score refreshes up front?"
            hint={
              <>
                Publishing scores requires a proof and an onchain transaction.
                Add ETH to pay approved provers for early refreshes, or leave
                this blank and produce proofs independently.{' '}
                <Link
                  href="/docs/build/run-a-prover"
                  className="underline underline-offset-4 hover:text-foreground"
                >
                  Learn how to run a prover.
                </Link>
              </>
            }
            error={prepayError}
          >
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <input
                  className="w-32 rounded border border-border bg-transparent px-2 py-1 text-sm"
                  inputMode="decimal"
                  placeholder="0.5"
                  value={data.prepayEth}
                  onChange={(event) =>
                    onChange({ prepayEth: event.target.value })
                  }
                />
                <span className="text-sm opacity-60">ETH (optional)</span>
              </div>

              {data.prepayEth.trim() && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">
                      Maximum paid per refresh
                    </label>
                    <div className="flex items-center gap-2">
                      <span className="text-sm opacity-60">$</span>
                      <input
                        className="w-32 rounded border border-border bg-transparent px-2 py-1 text-sm"
                        inputMode="decimal"
                        value={data.maxPerRootUsd}
                        onChange={(event) =>
                          onChange({ maxPerRootUsd: event.target.value })
                        }
                      />
                      <span className="text-sm opacity-60">USD</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Includes the proving fee and gas reimbursement.
                    </p>
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground">
                      Paid refresh schedule
                    </div>
                    <div className="text-sm">{describeBlocks(effective)}</div>
                    <p className="text-xs text-muted-foreground">
                      Starts with the score schedule and can be changed later by
                      governance.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </Field>
          {data.prepayEth.trim() && (
            <Note className="mt-3">
              You can top up later. Any withdrawal follows the proving
              vault&apos;s notice period.
            </Note>
          )}
        </Card>
      )}

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="px-0 hover:bg-transparent"
        onClick={() => setOpen(!open)}
      >
        {open ? (
          <ChevronDown className="h-4 w-4" />
        ) : (
          <ChevronRight className="h-4 w-4" />
        )}
        Advanced settings
        {!open && advancedChanged.length > 0 && (
          <span className="text-xs text-muted-foreground">
            ({advancedChanged.length} changed)
          </span>
        )}
      </Button>

      {open && (
        <div className="space-y-8 border-l border-border pl-4 sm:pl-6">
          <PercentSetting
            label="Head start for your starting accounts"
            value={tuning.headStartPct}
            onChange={(value) => setTuning({ headStartPct: value })}
            description="Of everything handed out before any vouching happens, this share is split between the accounts you picked. At 100%, an account disconnected from them starts at zero."
          />

          <PercentSetting
            label="Weight kept at each step away from a starting account"
            value={tuning.headStartKeptPct}
            onChange={(value) => setTuning({ headStartKeptPct: value })}
            description="A vouch from someone one step from a starting account carries this much of its weight. Two steps away, that much again, and so on. Set it low and only people close to your starting accounts count for much."
          />

          <Card type="outline" size="md" className="space-y-3">
            <div className="text-sm font-medium">
              What distance decay changes
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[30rem] text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="pb-2 pr-4 font-medium">Weight kept</th>
                    <th className="pb-2 pr-4 font-medium">
                      Reciprocal fake-account gain
                    </th>
                    <th className="pb-2 font-medium">Useful reach</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  <tr>
                    <td className="py-2 pr-4">60%</td>
                    <td className="py-2 pr-4">1.21×</td>
                    <td className="py-2">5 hops</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4">80% (default)</td>
                    <td className="py-2 pr-4">1.68×</td>
                    <td className="py-2">7 hops</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4">100%</td>
                    <td className="py-2 pr-4">6.17×</td>
                    <td className="py-2">No distance limit</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <Note>
              Lower decay limits how much a closed reciprocal loop can amplify
              its holder, but legitimate trust also stops travelling sooner.
              These are measured model results, not universal attack bounds.
            </Note>
          </Card>

          <Field
            label="Total points shared out"
            htmlFor="network-points"
            hint="Everyone's score is a slice of this number. It is only a scale: doubling it doubles every score and changes nothing about who ranks where."
          >
            <Input
              id="network-points"
              type="number"
              min={1}
              step={1}
              className="max-w-xs"
              value={tuning.totalPoints}
              onChange={(e) =>
                setTuning({ totalPoints: Math.max(1, Number(e.target.value)) })
              }
            />
          </Field>

          <div className="flex flex-row items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setTuning({
                  headStartPct: DEFAULT_TUNING.headStartPct,
                  headStartKeptPct: DEFAULT_TUNING.headStartKeptPct,
                  totalPoints: DEFAULT_TUNING.totalPoints,
                })
              }
              disabled={!advancedChanged.length}
            >
              Reset advanced settings
            </Button>
          </div>

          <Note>
            Arithmetic precision and iteration count are fixed because score
            proofs are verified against those values.
          </Note>
        </div>
      )}
    </div>
  )
}
