'use client'

import type React from 'react'

import { Button } from '@/components/Button'
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/Form'
import { Input } from '@/components/Input'
import { Textarea } from '@/components/Textarea'

import type { SchemaComponentProps } from './types'

/**
 * Generic schema component that dynamically renders form fields
 * based on the schema definition. Used as fallback for schemas
 * that don't have custom components.
 */
export function GenericSchemaComponent({
  form,
  schemaInfo,
  onSubmit,
  isLoading,
  error,
  isSuccess,
  hash,
}: SchemaComponentProps) {
  const handleSubmit = form.handleSubmit(onSubmit)

  return (
    <div className="space-y-4">
      {/* Dynamic Schema Fields */}
      {schemaInfo.fields.map(({ name, type }) => (
        <FormField
          key={schemaInfo.uid + ':' + name}
          control={form.control}
          name={`data.${name}`}
          rules={{ required: `Field ${name} is required` }}
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-sm font-medium">
                {name.charAt(0).toUpperCase() +
                  name.slice(1).replace(/([A-Z])/g, ' $1')}
              </FormLabel>

              <FormControl>
                {type.startsWith('uint') ? (
                  <Input
                    {...field}
                    type="number"
                    className="text-sm"
                    required
                  />
                ) : (
                  <Textarea {...field} className="text-sm min-h-20" required />
                )}
              </FormControl>
              <FormMessage className="text-xs" />
            </FormItem>
          )}
        />
      ))}

      {/* Submit Section */}
      <div className="pt-4 border-t border-border space-y-3">
        {/* Error Display */}
        {error && (
          <p className="text-destructive text-sm border border-destructive/50 bg-destructive/10 p-3 rounded-md">
            {error}
          </p>
        )}

        <Button
          onClick={handleSubmit}
          disabled={isLoading}
          className="px-6 py-2 w-full"
        >
          {isLoading ? 'Attesting...' : 'Make Attestation'}
        </Button>

        {/* Success Display */}
        {isSuccess && hash && (
          <div className="text-sm border border-success bg-success-soft text-success p-3 rounded-md">
            <div>
              ✓ Attestation created! Tx: {hash.slice(0, 10)}...
              {hash.slice(-8)}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
