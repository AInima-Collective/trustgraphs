'use client'

import { ChevronDown, ChevronRight } from 'lucide-react'
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
import { hasUnreservedTrustShare } from '@/lib/trust-share'

import {
  CADENCE_OPTIONS,
  Cadence,
  DEFAULT_TUNING,
  Tuning,
  WizardData,
  describeBlocks,
  effectiveBlocks,
  requestedBlocks,
} from '../model'
import { Field, Note, PercentSetting, StepHeader } from '../ui'

export const TuningStep = ({
  data,
  onChange,
  epochFloor,
}: {
  data: WizardData
  onChange: (patch: Partial<WizardData>) => void
  epochFloor: bigint
}) => {
  const [open, setOpen] = useState(false)
  const tuning = data.tuning
  const setTuning = (patch: Partial<Tuning>) =>
    onChange({ tuning: { ...tuning, ...patch } })

  const requested = requestedBlocks(tuning.cadence, epochFloor)
  const effective = effectiveBlocks(tuning.cadence, epochFloor)
  const raised = requested < effective

  const changed = (Object.keys(DEFAULT_TUNING) as (keyof Tuning)[]).filter(
    (key) => tuning[key] !== DEFAULT_TUNING[key]
  )

  return (
    <div className="space-y-6">
      <StepHeader
        title="How scores are worked out"
        lead="The defaults keep score anchored to your starting accounts. Most communities change nothing here."
      />

      <Card type="outline" size="md" className="space-y-2">
        <div className="text-sm">
          Scores are published {describeBlocks(effective)}.
        </div>
        <Note>
          Between publications people can vouch as much as they like. The
          numbers only move when the new scores are published.
        </Note>
      </Card>

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
        {!open && changed.length > 0 && (
          <span className="text-xs text-muted-foreground">
            ({changed.length} changed)
          </span>
        )}
      </Button>

      {open && (
        <div className="space-y-8 border-l border-border pl-4 sm:pl-6">
          <Field
            label="How often scores are published"
            hint="Publishing costs real money to run, so a slower cadence is cheaper and steadier. A faster one reacts sooner to new vouches."
          >
            <Select
              value={tuning.cadence}
              onValueChange={(value) =>
                setTuning({ cadence: value as Cadence })
              }
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
            <Note tone="warning" className="-mt-6">
              This chain will not publish more often than{' '}
              {describeBlocks(effective)}, so that is what your network gets.
            </Note>
          )}

          <PercentSetting
            label="How much scores lean on vouches"
            value={tuning.vouchWeightPct}
            min={1}
            max={99}
            onChange={(value) => setTuning({ vouchWeightPct: value })}
            description="Higher: almost all of someone's score comes from who vouched for them, and trust carries further across the network. Lower: more of the score is fixed by where everyone starts, and vouches barely move it."
          />

          <PercentSetting
            label="Head start for your starting accounts"
            value={tuning.headStartPct}
            onChange={(value) => setTuning({ headStartPct: value })}
            description="Of everything handed out before any vouching happens, this share is split between the accounts you picked. At 100%, an account disconnected from them starts at zero."
          />

          {hasUnreservedTrustShare(tuning.headStartPct) && (
            <Note tone="warning" className="-mt-6">
              Below 100%, the remainder is split among every other account. A
              disconnected group can then gain scoreboard share by adding
              accounts, even when no trust reaches it from your starting
              accounts.
            </Note>
          )}

          <PercentSetting
            label="Weight kept at each step away from a starting account"
            value={tuning.headStartKeptPct}
            onChange={(value) => setTuning({ headStartKeptPct: value })}
            description="A vouch from someone one step from a starting account carries this much of its weight. Two steps away, that much again, and so on. Set it low and only people close to your starting accounts count for much."
          />

          {/* Capped at 4x, not by taste: scores are worked out by repeated passes over the graph,
              and a boost above roughly 4.5x makes the numbers grow faster than they can be
              represented, which the network refuses at creation. 4x leaves margin. */}
          <PercentSetting
            label="How much a vouch from a starting account counts"
            value={tuning.startingAccountBoost}
            min={1}
            max={4}
            suffix="x"
            onChange={(value) => setTuning({ startingAccountBoost: value })}
            description="A vouch from one of the accounts you picked counts this many times more than a vouch from anyone else. Above about four times, the scores grow too fast to work out reliably, so that is the limit."
          />

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
              onClick={() => onChange({ tuning: DEFAULT_TUNING })}
              disabled={!changed.length}
            >
              Back to the defaults
            </Button>
          </div>

          <Note>
            A few more settings, like how precise the arithmetic is and how many
            rounds it runs, are the same for every network here and cannot be
            changed. They are what the proof of the scores is checked against.
          </Note>
        </div>
      )}
    </div>
  )
}
