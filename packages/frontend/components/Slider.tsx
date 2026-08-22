'use client'

import {
  KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'

import { useUpdatingRef } from '@/hooks/useUpdatingRef'
import { cn } from '@/lib/utils'

export interface SliderProps {
  value: number
  onValueChange: (value: number) => void
  ariaLabel: string
  ariaValueText?: string
  min?: number
  max?: number
  className?: string
}

export const Slider = ({
  value,
  onValueChange,
  ariaLabel,
  ariaValueText,
  max = 100,
  min = 0,
  className,
}: SliderProps) => {
  const [isDragging, setIsDragging] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const range = Math.max(max - min, 1)

  const onValueChangeRef = useUpdatingRef(onValueChange)
  const updateValue = useCallback(
    (e: MouseEvent | TouchEvent) => {
      if (!ref.current) {
        return
      }

      const rect = ref.current.getBoundingClientRect()
      const clientX =
        'touches' in e && e.touches.length > 0
          ? e.touches[0].clientX
          : 'clientX' in e
            ? e.clientX
            : 0

      // Mouse event may or may not be within the bounds of the slider, so clamp.
      const x = Math.max(rect.left, Math.min(rect.right, clientX))
      const percentage = Math.round(((x - rect.left) / rect.width) * 100)
      const newValue = Math.min(Math.max(min, percentage), max)

      onValueChangeRef.current(newValue)
    },
    [min, max, onValueChangeRef]
  )

  const handleStart = (e: MouseEvent | TouchEvent) => {
    setIsDragging(true)
    updateValue(e)
  }

  useEffect(() => {
    if (!isDragging) {
      return
    }

    const handleEnd = () => {
      setIsDragging(false)
    }

    document.addEventListener('mouseup', handleEnd)
    document.addEventListener('mousemove', updateValue)
    document.addEventListener('touchend', handleEnd)
    document.addEventListener('touchmove', updateValue)

    return () => {
      document.removeEventListener('mouseup', handleEnd)
      document.removeEventListener('mousemove', updateValue)
      document.removeEventListener('touchend', handleEnd)
      document.removeEventListener('touchmove', updateValue)
    }
  }, [isDragging, updateValue])

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let next = value
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        next = value + 1
        break
      case 'ArrowLeft':
      case 'ArrowDown':
        next = value - 1
        break
      case 'PageUp':
        next = value + 10
        break
      case 'PageDown':
        next = value - 10
        break
      case 'Home':
        next = min
        break
      case 'End':
        next = max
        break
      default:
        return
    }
    event.preventDefault()
    onValueChange(Math.min(max, Math.max(min, next)))
  }

  return (
    <div
      ref={ref}
      className={cn(
        'relative flex h-11 w-full cursor-pointer touch-none select-none items-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink',
        className
      )}
      role="slider"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={ariaValueText ?? `${value} out of ${max}`}
      onMouseDown={(e) => handleStart(e.nativeEvent)}
      onTouchStart={(e) => handleStart(e.nativeEvent)}
      onClick={(e) => updateValue(e.nativeEvent)}
      onKeyDown={handleKeyDown}
    >
      <div className="absolute inset-x-0 h-2 overflow-hidden border border-hairline-strong bg-surface-2">
        <div
          className="h-full bg-ink"
          style={{ width: `${((value - min) / range) * 100}%` }}
        />
      </div>
      {/* Thumb */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute block h-7 w-4 border border-ink bg-surface"
        style={{
          left: `calc((100% - 1rem) * ${(value - min) / range})`,
        }}
      />
    </div>
  )
}
