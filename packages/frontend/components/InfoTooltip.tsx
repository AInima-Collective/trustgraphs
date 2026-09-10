'use client'

import { Info } from 'lucide-react'

import { cn } from '@/lib/utils'

import { Tooltip } from './Tooltip'

interface InfoTooltipProps {
  title: string
  className?: string
}

export const InfoTooltip = ({ title, className }: InfoTooltipProps) => {
  return (
    <Tooltip
      title={title}
      className={cn(
        'tg-touch-target inline-flex min-h-6 min-w-6 shrink-0 items-center justify-center text-text-subtle transition-colors hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink',
        className
      )}
    >
      <Info size={14} className="shrink-0" />
    </Tooltip>
  )
}
