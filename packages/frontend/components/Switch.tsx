import { LoaderCircle } from 'lucide-react'
import { MouseEvent } from 'react'

import { cn } from '@/lib/utils'

export type SwitchProps = {
  enabled: boolean
  onClick?: (event: MouseEvent<HTMLDivElement>) => void
  className?: string
  size?: 'sm' | 'md' | 'lg'
  readOnly?: boolean
  loading?: boolean
}

export const Switch = ({
  enabled,
  onClick,
  className,
  size = 'lg',
  readOnly,
  loading,
}: SwitchProps) => {
  readOnly ||= loading

  return (
    <div
      className={cn(
        'relative flex flex-none items-center border',
        {
          'cursor-pointer hover:opacity-90': !readOnly,
          'border-ink bg-ink': enabled,
          'border-hairline-strong bg-transparent': !enabled,
          // Sizing.
          'h-[16px] w-[28px]': size === 'sm',
          'h-[27px] w-[47px]': size === 'md',
          'h-[38px] w-[67px]': size === 'lg',
        },
        className
      )}
      onClick={readOnly ? undefined : onClick}
    >
      <div
        className={cn(
          'absolute flex items-center justify-center transition-all',
          enabled ? 'bg-ink-fg' : 'bg-text-subtle',
          // Sizing.
          {
            // Small
            'h-[10px] w-[10px]': size === 'sm',
            'left-[15px]': size === 'sm' && enabled,
            'left-[2px]': size === 'sm' && !enabled,
            // Medium
            'h-[18px] w-[18px]': size === 'md',
            'left-[24px]': size === 'md' && enabled,
            'left-[4px]': size === 'md' && !enabled,
            // Large
            'h-[28px] w-[28px]': size === 'lg',
            'left-[33px]': size === 'lg' && enabled,
            'left-[4.5px]': size === 'lg' && !enabled,
          }
        )}
      >
        {loading && (
          <LoaderCircle
            size={
              // Match parent size.
              size === 'lg' ? 28 : size === 'md' ? 18 : 10
            }
            className="animate-spin text-muted-foreground flex-shrink-0"
          />
        )}
      </div>
    </div>
  )
}
