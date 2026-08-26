'use client'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/Select'

import {
  CADENCE_OPTIONS,
  type Cadence,
  describeBlocks,
  effectiveBlocks,
  requestedBlocks,
} from './model'
import { Field, Note } from './ui'

export const CadenceField = ({
  id,
  value,
  epochFloor,
  onChange,
}: {
  id: string
  value: Cadence
  epochFloor: bigint
  onChange: (value: Cadence) => void
}) => {
  const requested = requestedBlocks(value, epochFloor)
  const effective = effectiveBlocks(value, epochFloor)
  const raised = requested < effective

  return (
    <div className="space-y-3">
      <Field
        label="How often scores can be recalculated"
        htmlFor={id}
        hint="New vouches appear immediately, but scores change only after someone publishes a new proof. Faster schedules respond sooner and cost more to maintain."
      >
        <Select
          value={value}
          onValueChange={(next) => onChange(next as Cadence)}
        >
          <SelectTrigger id={id} className="max-w-md">
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
    </div>
  )
}
