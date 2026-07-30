'use client'

import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'

import { cn } from '@/lib/utils'

/**
 * Two filled circles — one ink, one paper — reading as a single coin that
 * flips. No sun, no moon: the rest of the interface has no illustration in it
 * and a weather icon here would be the only one.
 *
 * Renders a fixed-size placeholder until mounted. `useTheme` cannot know the
 * resolved theme during SSR, and swapping the glyph post-hydration would
 * shift the nav.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const isDark = resolvedTheme !== 'light'

  return (
    <button
      type="button"
      aria-label={
        mounted
          ? `Switch to ${isDark ? 'light' : 'dark'} theme`
          : 'Switch theme'
      }
      title={
        mounted ? `Switch to ${isDark ? 'light' : 'dark'} theme` : undefined
      }
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className={cn(
        // 44px, not 36px: this is a touch target on every phone that loads the
        // app, and it sits in a nav row where every other control now clears
        // the same floor.
        'inline-flex h-11 w-11 shrink-0 items-center justify-center border border-border',
        'text-text-muted transition-colors hover:border-hairline-strong hover:text-text',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        className
      )}
    >
      {mounted ? (
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          focusable="false"
        >
          {/* Left disc is always hollow, right disc always solid; the pair
           * rotates a half-turn between themes so the solid side tracks
           * which way the interface is currently inverted. */}
          <g
            style={{
              transform: isDark ? 'none' : 'rotate(180deg)',
              transformOrigin: '50% 50%',
              transition: 'transform 240ms ease',
            }}
          >
            <circle
              cx="5.5"
              cy="8"
              r="3.5"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <circle cx="10.5" cy="8" r="3.5" fill="currentColor" />
          </g>
        </svg>
      ) : (
        <span className="block h-4 w-4" />
      )}
    </button>
  )
}
