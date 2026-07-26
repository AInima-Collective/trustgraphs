'use client'

import type React from 'react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/Button'
import { Checkbox } from '@/components/Checkbox'
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/Form'
import { Slider } from '@/components/Slider'
import { Textarea } from '@/components/Textarea'

import type { SchemaComponentProps } from './types'
import { Markdown } from '../Markdown'

/**
 * Custom schema component for vouching attestations.
 * Provides specialized UI for confidence scoring and endorsement validation.
 */
export function CreateVouchingSchema({
  form,
  schemaInfo: _schemaInfo,
  onSubmit,
  isLoading,
  error,
  isSuccess,
  hash,
  network,
}: SchemaComponentProps) {
  const [endorsementChecked, setEndorsementChecked] = useState(false)

  // Set default confidence value if not set
  const confidenceValue = form.watch('data.confidence') || '100'

  // Initialize confidence field with default value on mount
  useEffect(() => {
    const currentConfidence = form.getValues('data.confidence')
    if (!currentConfidence) {
      form.setValue('data.confidence', '100')
    }
  }, [form])

  // Handle slider change
  const handleSliderChange = (value: number) => {
    form.setValue('data.confidence', value.toString())
  }

  const handleSubmit = form.handleSubmit((data) => {
    if (!endorsementChecked) {
      // This shouldn't happen due to button disable, but extra safety
      return
    }

    // Ensure all required fields are present
    const formData = {
      ...data,
      data: {
        comment: data.data.comment || '',
        confidence: data.data.confidence || '100',
      },
    }

    onSubmit(formData)
  })

  return (
    <div className="space-y-6">
      {network ? (
        <div className="space-y-2">
          <div className="text-sm font-bold">NETWORK CRITERIA</div>
          <Markdown className="text-sm">{network.criteria}</Markdown>
        </div>
      ) : (
        // Default message if no network is provided
        <div className="text-primary text-sm">
          Express your trust in this person and optionally add a comment.
        </div>
      )}

      {/* Endorsement Checkbox */}
      <div className="space-y-2">
        <p className="text-sm font-bold">
          I ENDORSE THIS PERSON MEETS THE NETWORK CRITERIA
        </p>

        <div className="flex flex-row gap-2 items-center">
          <Checkbox
            checked={endorsementChecked}
            onCheckedChange={(checked: boolean) =>
              setEndorsementChecked(!!checked)
            }
          />
          <p
            className="text-sm cursor-pointer"
            onClick={() => setEndorsementChecked((c) => !c)}
          >
            Yes
          </p>
        </div>
      </div>

      {/* Confidence Slider */}
      <FormField
        control={form.control}
        name="data.confidence"
        rules={{
          min: { value: 0, message: 'Confidence must be at least 0' },
          max: { value: 100, message: 'Confidence cannot exceed 100' },
        }}
        render={({ field: _field }) => (
          <FormItem>
            <FormLabel className="text-sm font-bold">
              HOW CONFIDENT ARE YOU?
            </FormLabel>
            <FormControl>
              <div className="flex flex-row gap-2 items-center mt-1">
                {/* Slider */}
                <Slider
                  value={confidenceValue ? parseInt(confidenceValue) : 100}
                  onValueChange={handleSliderChange}
                  max={100}
                  min={0}
                  className="grow"
                />

                <span className="text-sm text-muted-foreground w-[4ch] text-right">
                  {confidenceValue}%
                </span>

                {/* Number Input */}
                {/* <div className="flex items-center space-x-2">
                  <span className="text-sm text-muted-foreground">
                    or type:
                  </span>
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    value={confidenceValue}
                    onChange={(e) => handleNumberInputChange(e.target.value)}
                    className="w-20 text-sm"
                  />
                  <span className="text-sm text-muted-foreground">%</span>
                </div> */}
              </div>
            </FormControl>
            <FormMessage className="text-xs" />
          </FormItem>
        )}
      />

      {/* Optional Comment */}
      <FormField
        control={form.control}
        name="data.comment"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="text-sm font-bold">
              COMMENT (OPTIONAL)
            </FormLabel>
            <FormControl>
              <Textarea
                {...field}
                value={field.value || ''}
                onChange={(e) => field.onChange(e.target.value)}
                placeholder="Add any additional context about your vouching decision..."
                className="text-sm min-h-20 resize-y mt-1"
              />
            </FormControl>
            <FormMessage className="text-xs" />
          </FormItem>
        )}
      />

      {/* Submit Section */}
      <div className="space-y-3">
        {/* Error Display */}
        {error && (
          <p className="text-destructive text-sm border border-destructive/50 bg-destructive/10 p-3 rounded-md">
            {error}
          </p>
        )}

        {!endorsementChecked && (
          <p className="text-xs text-muted-foreground text-center">
            You must confirm the endorsement above to make this attestation.
          </p>
        )}

        <Button
          onClick={handleSubmit}
          disabled={isLoading || !endorsementChecked}
          className="px-6 py-2 w-full"
        >
          {isLoading ? 'Attesting...' : 'Make Attestation'}
        </Button>

        {/* Success Display */}
        {isSuccess && hash && (
          <div className="text-sm border border-success bg-success-soft text-success p-3 rounded-md">
            <div>
              ✓ Vouch created successfully! Tx: {hash.slice(0, 10)}...
              {hash.slice(-8)}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
