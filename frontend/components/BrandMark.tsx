'use client'

import type { ReactElement, SVGProps } from 'react'

import { type MarkId, useMarkId } from '@/lib/labTheme'
import { cn } from '@/lib/utils'

export type BrandMarkSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

const SIZES: Record<BrandMarkSize, number> = {
  xs: 12,
  sm: 16,
  md: 24,
  lg: 48,
  xl: 96,
}

/**
 * Candidate brand marks, all on a 32×32 grid with a 2-unit stroke so they
 * carry the same optical weight at any size. Everything paints from
 * `currentColor` — there is no accent fill any more, because the palette no
 * longer has a brand hue to spend on a logo.
 *
 * The floor is 12px (the nav on mobile): one grid unit is 0.375px there, so
 * nothing below relies on detail finer than ~3 units. That rules out hollow
 * circles under r=3 and any stroke under 1.5.
 *
 * Three families, per the direction call:
 *   graph  — nodes and directed edges, the literal substance
 *   sigil  — the occult-diagram register: rings, chords, inscribed figures
 *   rank   — PageRank made visible: mass, concentration, decay
 */
const GEOMETRY: Record<MarkId, ReactElement> = {
  // ── Graph primitives ──────────────────────────────────────────────────────

  /** One attestation. Hollow node vouches for filled node; the fill *is* the
   * direction, which is why there is no arrowhead to lose at 12px. */
  edge: (
    <>
      <circle cx="7" cy="16" r="4" stroke="currentColor" strokeWidth="2" />
      <path d="M11 16 H21" stroke="currentColor" strokeWidth="2" />
      <circle cx="25" cy="16" r="4" fill="currentColor" />
    </>
  ),

  /** K3 — the smallest complete graph, and the smallest group in which trust
   * can be corroborated rather than merely asserted. */
  triad: (
    <>
      <path
        d="M16 5.5 L25.9 22.7 H6.1 Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <circle cx="16" cy="5.5" r="3.5" fill="currentColor" />
      <circle cx="25.9" cy="22.7" r="3.5" fill="currentColor" />
      <circle cx="6.1" cy="22.7" r="3.5" fill="currentColor" />
    </>
  ),

  /** The star graph K(1,6) — the current asterisk, but built as a graph
   * instead of drawn as a burst. Included mostly as the control. */
  fan: (
    <>
      <path
        d="M16 16 L28 16 M16 16 L22 5.6 M16 16 L10 5.6 M16 16 L4 16 M16 16 L10 26.4 M16 16 L22 26.4"
        stroke="currentColor"
        strokeWidth="2"
      />
      <circle cx="16" cy="16" r="4.5" fill="currentColor" />
      <circle cx="28" cy="16" r="2.6" fill="currentColor" />
      <circle cx="22" cy="5.6" r="2.6" fill="currentColor" />
      <circle cx="10" cy="5.6" r="2.6" fill="currentColor" />
      <circle cx="4" cy="16" r="2.6" fill="currentColor" />
      <circle cx="10" cy="26.4" r="2.6" fill="currentColor" />
      <circle cx="22" cy="26.4" r="2.6" fill="currentColor" />
    </>
  ),

  /** The merkle fold: four leaves commit to two, two commit to one. Node size
   * grades upward because that is where the mass ends up. */
  fold: (
    <>
      <path
        d="M4 25.5 L8.5 17 M12.5 25.5 L8.5 17 M20 25.5 L24 17 M28 25.5 L24 17 M8.5 15 L16 7.5 M24 15 L16 7.5"
        stroke="currentColor"
        strokeWidth="2"
      />
      <circle cx="16" cy="6.5" r="4" fill="currentColor" />
      <circle cx="8.5" cy="16" r="3" fill="currentColor" />
      <circle cx="24" cy="16" r="3" fill="currentColor" />
      <circle cx="4" cy="26.5" r="2.4" fill="currentColor" />
      <circle cx="12.5" cy="26.5" r="2.4" fill="currentColor" />
      <circle cx="20" cy="26.5" r="2.4" fill="currentColor" />
      <circle cx="28" cy="26.5" r="2.4" fill="currentColor" />
    </>
  ),

  /** Reciprocal attestation — two nodes, two arcs, one in each direction. The
   * enclosed shape is a vesica, which is a happy accident rather than a plan. */
  mutual: (
    <>
      <path d="M8 12.6 Q16 3.5 24 12.6" stroke="currentColor" strokeWidth="2" />
      <path
        d="M8 19.4 Q16 28.5 24 19.4"
        stroke="currentColor"
        strokeWidth="2"
      />
      <circle cx="7.5" cy="16" r="3.6" fill="currentColor" />
      <circle cx="24.5" cy="16" r="3.6" fill="currentColor" />
    </>
  ),

  /** Attesters on the left, subjects on the right, edges crossing between —
   * the bipartite reading of a vouching set. */
  cross: (
    <>
      <path
        d="M8.5 9.5 L23.5 22.5 M8.5 22.5 L23.5 9.5"
        stroke="currentColor"
        strokeWidth="2"
      />
      <circle cx="7" cy="8.5" r="3.4" stroke="currentColor" strokeWidth="2" />
      <circle cx="7" cy="23.5" r="3.4" stroke="currentColor" strokeWidth="2" />
      <circle cx="25" cy="8.5" r="3.4" fill="currentColor" />
      <circle cx="25" cy="23.5" r="3.4" fill="currentColor" />
    </>
  ),

  // ── Sigil / seal ──────────────────────────────────────────────────────────

  /** Ring, inscribed triangle point-down, node at the centre. The most
   * straightforwardly sigil-shaped of the set. */
  seal: (
    <>
      <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="2" />
      <path
        d="M6.5 10.5 H25.5 L16 27 Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <circle cx="16" cy="16" r="2.6" fill="currentColor" />
    </>
  ),

  /** Ring with an inscribed pentagon and a centre node. A pentagon rather
   * than a pentagram: the five-fold symmetry without the costume. The pentagon
   * sits at r=9.5 inside an r=13 ring — at the inscribed radius the two figures
   * touch at five points and the whole thing muddies into a blob. */
  pentad: (
    <>
      <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="2" />
      <path
        d="M16 6.5 L25.04 13.06 L21.58 23.69 L10.42 23.69 L6.96 13.06 Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <circle cx="16" cy="16" r="2.6" fill="currentColor" />
    </>
  ),

  /** Two sets and what they hold in common. The node marks the intersection,
   * which is the only part either party can prove. */
  overlap: (
    <>
      <circle cx="11.5" cy="16" r="9" stroke="currentColor" strokeWidth="2" />
      <circle cx="20.5" cy="16" r="9" stroke="currentColor" strokeWidth="2" />
      <circle cx="16" cy="16" r="2.6" fill="currentColor" />
    </>
  ),

  /** Three parties inside one boundary, corroborating each other. A scalene
   * triangle, not an equilateral one: symmetry would read as an ornament,
   * and the asymmetry is what makes it read as a diagram of something.
   *
   * (The first cut of this was two chords crossing near the middle. With the
   * ring around them the four resulting spokes read as a ship's wheel, which
   * is a good lesson about how little it takes for radial symmetry to take
   * over a mark.) */
  chord: (
    <>
      <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="2" />
      <path
        d="M19.36 3.44 L27.26 22.5 L3.44 19.36 Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <circle cx="19.36" cy="3.44" r="3.2" fill="currentColor" />
      <circle cx="27.26" cy="22.5" r="3.2" fill="currentColor" />
      <circle cx="3.44" cy="19.36" r="3.2" fill="currentColor" />
    </>
  ),

  /** A boundary, a threshold across it, and something already through. */
  gate: (
    <>
      <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="2" />
      <path d="M3.5 16 H28.5" stroke="currentColor" strokeWidth="2" />
      <circle cx="21.5" cy="16" r="3.6" fill="currentColor" />
    </>
  ),

  // ── Rank / mass ───────────────────────────────────────────────────────────

  /** Mass concentrating. Ring weight decays outward, so the eye lands in the
   * middle without being told to. */
  concentric: (
    <>
      <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="16" cy="16" r="8.5" stroke="currentColor" strokeWidth="2" />
      <circle cx="16" cy="16" r="4" fill="currentColor" />
    </>
  ),

  /** The heaviest node is not the centre one. That is the whole argument for
   * eigenvector rank over a headcount, drawn in three marks. */
  orbit: (
    <>
      <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="2" />
      <circle cx="16" cy="16" r="2.4" fill="currentColor" />
      <circle cx="25.9" cy="24.4" r="4" fill="currentColor" />
    </>
  ),

  /** The rank plot itself: a power law, four bars, no axis. */
  rank: (
    <>
      <rect x="3.5" y="4" width="4.5" height="24" fill="currentColor" />
      <rect x="10.75" y="15" width="4.5" height="13" fill="currentColor" />
      <rect x="18" y="21" width="4.5" height="7" fill="currentColor" />
      <rect x="25.25" y="24.5" width="4.5" height="3.5" fill="currentColor" />
    </>
  ),

  /** Nested frames drifting off-centre toward the sink. Trust does not settle
   * evenly, and a concentric version would be a lie about that. The drift has
   * to be large — a subtle offset just reads as a mistake. */
  well: (
    <>
      <rect
        x="2"
        y="2"
        width="23"
        height="23"
        stroke="currentColor"
        strokeWidth="2"
      />
      <rect
        x="8.5"
        y="8.5"
        width="17"
        height="17"
        stroke="currentColor"
        strokeWidth="2"
      />
      <rect x="15" y="15" width="11" height="11" fill="currentColor" />
    </>
  ),

  /** A ring that is not continuous: eight members, unequal weight, no centre.
   * The set holds the shape, not any one node in it. */
  quorum: (
    <>
      <circle cx="16" cy="5" r="4" fill="currentColor" />
      <circle cx="23.8" cy="8.2" r="2.5" fill="currentColor" />
      <circle cx="27" cy="16" r="2.5" fill="currentColor" />
      <circle cx="23.8" cy="23.8" r="4" fill="currentColor" />
      <circle cx="16" cy="27" r="2.5" fill="currentColor" />
      <circle cx="8.2" cy="23.8" r="2.5" fill="currentColor" />
      <circle cx="5" cy="16" r="4" fill="currentColor" />
      <circle cx="8.2" cy="8.2" r="2.5" fill="currentColor" />
    </>
  ),
}

export type BrandMarkProps = Omit<SVGProps<SVGSVGElement>, 'children'> & {
  size?: BrandMarkSize
  className?: string
  title?: string
  /**
   * Render a specific candidate instead of the active selection. Used by the
   * lab's mark sheet to show all sixteen at once; app surfaces omit it so they
   * follow whatever is currently selected.
   */
  mark?: MarkId
}

export function BrandMark({
  size = 'sm',
  className,
  title,
  mark,
  ...rest
}: BrandMarkProps) {
  const active = useMarkId()
  const resolved = mark ?? active
  const px = SIZES[size]
  const labelled = Boolean(title)
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      width={px}
      height={px}
      fill="none"
      className={cn('shrink-0', className)}
      role={labelled ? 'img' : undefined}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {GEOMETRY[resolved] ?? GEOMETRY.chord}
    </svg>
  )
}

/** Family + one-line rationale, read by the lab's mark sheet. */
export const MARK_META: Record<MarkId, { family: string; note: string }> = {
  edge: { family: 'graph', note: 'one attestation; fill is the direction' },
  triad: { family: 'graph', note: 'K3 — the smallest corroborating set' },
  fan: { family: 'graph', note: 'the asterisk, rebuilt as a star graph' },
  fold: { family: 'graph', note: 'merkle fold; mass grades upward' },
  mutual: { family: 'graph', note: 'reciprocal attestation, both directions' },
  cross: { family: 'graph', note: 'bipartite: attesters to subjects' },
  seal: { family: 'sigil', note: 'ring, inscribed triangle, centre node' },
  pentad: { family: 'sigil', note: 'five-fold symmetry without the costume' },
  overlap: { family: 'sigil', note: 'two sets; the node is what is provable' },
  chord: { family: 'sigil', note: 'three corroborating parties, one boundary' },
  gate: { family: 'sigil', note: 'a threshold, already crossed' },
  concentric: { family: 'rank', note: 'ring weight decays outward' },
  orbit: { family: 'rank', note: 'the heaviest node is not the centre' },
  rank: { family: 'rank', note: 'the power law, four bars, no axis' },
  well: { family: 'rank', note: 'nested frames drifting toward the sink' },
  quorum: { family: 'rank', note: 'eight members, unequal weight, no centre' },
}
