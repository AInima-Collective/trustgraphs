import { ComponentProps, forwardRef } from 'react'

import { cn } from '@/lib/utils'

export type CardProps = ComponentProps<'div'> & {
  type: 'primary' | 'accent' | 'detail' | 'popover' | 'outline'
  size: 'sm' | 'md' | 'lg'
}

/**
 * Every card is a hairline rectangle. There is no elevation in this system:
 * depth is communicated by rules and fills, never by shadow, so `primary`
 * dropped its transition-shadow rather than gaining a border-only twin.
 */
const baseClasses = 'border'
const typeClassesMap = {
  primary: 'border-border bg-surface',
  accent: 'border-border bg-surface-2',
  detail: 'border-transparent bg-surface-2',
  popover: 'border-hairline-strong bg-surface',
  outline: 'border-border bg-transparent',
}
const sizeClassesMap = {
  sm: 'px-4 py-3',
  md: 'px-5 py-4',
  lg: 'px-6 py-5',
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, type, size, ...props }: CardProps,
  ref
) {
  const typeClasses = typeClassesMap[type]
  const sizeClasses = sizeClassesMap[size]

  return (
    <div
      {...props}
      className={cn(baseClasses, typeClasses, sizeClasses, className)}
      ref={ref}
    />
  )
})
