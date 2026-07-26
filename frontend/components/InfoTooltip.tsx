'use client'

import { Info } from 'lucide-react'

import { cn } from '@/lib/utils'

import { Tooltip } from './Tooltip'

interface InfoTooltipProps {
  title: string
  className?: string
  iconClassName?: string
}

export const InfoTooltip = ({
  title,
  className,
  iconClassName,
}: InfoTooltipProps) => {
  return (
    <Tooltip
      title={title}
      className={cn(
        'inline-flex items-center justify-center p-0.5 transition-colors',
        'text-[#a1a1a1] hover:text-[#818181] focus:text-[#818181]',
        'focus:outline-none focus:ring-1 focus:ring-[#a1a1a1] focus:ring-offset-1',
        className
      )}
    >
      <Info size={14} className={cn('shrink-0', iconClassName)} />
    </Tooltip>
  )
}
