import type { SVGProps } from 'react'

import { cn } from '@/lib/utils'

export type BrandMarkSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

const SIZES: Record<BrandMarkSize, number> = {
  xs: 12,
  sm: 16,
  md: 24,
  lg: 48,
  xl: 96,
}

export type BrandMarkProps = Omit<SVGProps<SVGSVGElement>, 'children'> & {
  size?: BrandMarkSize
  className?: string
  title?: string
}

/**
 * `chord` — the trustgraphs mark. Three parties inside one boundary,
 * corroborating each other.
 *
 * A 32×32 grid with a 2-unit stroke, so it carries the same optical weight at
 * any size. Everything paints from `currentColor`: the palette has no brand hue
 * to spend on a logo. The floor is 12px (the footer colophon), where one grid
 * unit is 0.375px, which is why nothing here relies on detail finer than about
 * three units.
 *
 * The triangle is scalene rather than equilateral on purpose. Symmetry reads as
 * an ornament; the asymmetry is what makes it read as a diagram of something.
 * (The first cut was two chords crossing near the middle. With the ring around
 * them the four spokes read as a ship's wheel, which is a good lesson in how
 * little it takes for radial symmetry to take over a mark.)
 *
 * `scripts/generate-brand-assets.mjs` carries its own copy of this geometry for
 * the icon and share-card rasters. Change one, change both, then re-run
 * `pnpm run brand:assets`.
 */
export function BrandMark({
  size = 'sm',
  className,
  title,
  ...rest
}: BrandMarkProps) {
  const px = SIZES[size]
  const labelled = Boolean(title)
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      width={px}
      height={px}
      fill="none"
      // `forced-color-adjust-auto` is not decoration. Chromium gives SVG a used
      // value of `preserve-parent-color`, which means a colour declared ON the
      // svg survives a forced-colors theme instead of being replaced by the
      // system palette. Every call site passes its colour through `className`,
      // i.e. onto this element, so in Windows High Contrast the mark kept
      // painting `--text-subtle` against Canvas: measured 1.16:1 for the nav
      // mark in a light HC theme, 1.95:1 in the footer, 2.26:1 in the hero
      // panel. Below 410px the wordmark is hidden, so the home link was
      // rendering as nothing visible at all. The sibling svgs that do NOT take
      // a colour class here (the theme toggle, the FAQ disclosure marker)
      // measured 21:1 and 3.60:1, which is what proves the mechanism.
      className={cn('shrink-0 forced-color-adjust-auto', className)}
      role={labelled ? 'img' : undefined}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="2" />
      <path
        d="M19.36 3.44 L27.26 22.5 L3.44 19.36 Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <circle cx="19.36" cy="3.44" r="3.2" fill="currentColor" />
      <circle cx="27.26" cy="22.5" r="3.2" fill="currentColor" />
      <circle cx="3.44" cy="19.36" r="3.2" fill="currentColor" />
    </svg>
  )
}
