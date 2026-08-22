'use client'

import { ReactNode } from 'react'

import { Label } from '@/components/Label'
import { cn } from '@/lib/utils'

/** The heading + one-line explanation every wizard screen opens with. */
export const StepHeader = ({
  title,
  lead,
}: {
  title: string
  lead?: ReactNode
}) => (
  <div className="space-y-2">
    <h2 className="text-lg">{title}</h2>
    {lead && <p className="text-sm text-muted-foreground max-w-2xl">{lead}</p>}
  </div>
)

/** A labelled input with its own help text and its own error line. */
export const Field = ({
  label,
  hint,
  error,
  optional,
  htmlFor,
  children,
  className,
}: {
  label: string
  hint?: ReactNode
  error?: string | null
  optional?: boolean
  htmlFor?: string
  children: ReactNode
  className?: string
}) => (
  <div className={cn('space-y-2', className)}>
    <div className="flex flex-row items-baseline justify-between gap-3">
      <Label htmlFor={htmlFor}>{label}</Label>
      {optional && (
        <span className="text-xs text-muted-foreground">optional</span>
      )}
    </div>
    {children}
    {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    {error && <p className="text-xs text-destructive">{error}</p>}
  </div>
)

/** A quiet aside: consequences, warnings, and the things we are not pretending about. */
export const Note = ({
  children,
  tone = 'muted',
  className,
}: {
  children: ReactNode
  tone?: 'muted' | 'warning' | 'error'
  className?: string
}) => (
  <p
    className={cn(
      'text-xs leading-relaxed',
      tone === 'muted' && 'text-muted-foreground',
      tone === 'warning' && 'text-foreground',
      tone === 'error' && 'text-destructive',
      className
    )}
  >
    {children}
  </p>
)

/** A row in the review summary. */
export const SummaryRow = ({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) => (
  <div className="flex flex-col sm:flex-row sm:gap-4 py-2 border-b border-border last:border-b-0">
    <div className="text-xs text-muted-foreground sm:w-56 sm:shrink-0 sm:pt-0.5">
      {label}
    </div>
    <div className="text-sm break-words min-w-0">{children}</div>
  </div>
)

/** A labelled percentage slider that always states what the number means. */
export const PercentSetting = ({
  label,
  value,
  onChange,
  min = 0,
  max = 100,
  suffix = '%',
  description,
}: {
  label: string
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  suffix?: string
  description: ReactNode
}) => (
  <div className="space-y-2">
    <div className="flex flex-row items-center justify-between gap-4">
      <Label>{label}</Label>
      <div className="flex flex-row items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-40 sm:w-56 accent-primary cursor-pointer"
          aria-label={label}
        />
        <span className="text-sm tabular-nums w-12 text-right">
          {value}
          {suffix}
        </span>
      </div>
    </div>
    <p className="text-xs text-muted-foreground max-w-2xl">{description}</p>
  </div>
)
