/**
 * The three figures under "Three moves." — one per panel, drawn in one file
 * because they are one set and only work if they share a language.
 *
 * That language: a 148 × 84 frame, hairline strokes, accounts as filled
 * circles, and value (not colour, not weight) carrying meaning. A thing that is
 * dimmer has less trust in it. Ink only, per the design rules.
 *
 * Hand-drawn rather than generated. Fixed coordinates mean the picture is the
 * same in every render, in every screenshot, and in the reviewer's memory —
 * which a force-directed layout of eight nodes would not be.
 *
 * All three are `aria-hidden`: each one restates the paragraph above it, and a
 * screen reader that has just read "a bot island nobody real vouches for gains
 * nothing" does not need to be told again in worse words.
 */

/** One frame, so the three drawings scale as one row. */
function Frame({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <svg
      viewBox="0 0 148 84"
      className={className}
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

/**
 * 1 · Vouch. A signed statement travels from one account to another, carrying a
 * weight, and a dashed path underneath says it can come back.
 *
 * The statement is drawn as a card rather than as a bare arrow because the
 * paragraph is about *signing* something public. An arrow between two dots
 * would be the same picture as panel 2's edges and would say less.
 */
export function VouchFigure({ className }: { className?: string }) {
  return (
    <Frame className={className}>
      {/* Attester, statement, the account it names. */}
      <path
        d="M20 38 H46 M92 38 H118"
        stroke="currentColor"
        strokeWidth="1.1"
        opacity="0.8"
      />
      <path
        d="M114 34 L120 38 L114 42"
        stroke="currentColor"
        strokeWidth="1.1"
        opacity="0.8"
      />

      {/* The statement: two lines of it, and a signature under them. */}
      <rect
        x="48"
        y="22"
        width="44"
        height="32"
        stroke="currentColor"
        strokeWidth="1.1"
      />
      <path
        d="M56 32 H80 M56 38 H74"
        stroke="currentColor"
        strokeWidth="1"
        opacity="0.5"
      />
      <path
        d="M56 46 C 60 41, 63 49, 67 44 S 74 41, 80 46"
        stroke="currentColor"
        strokeWidth="1"
      />

      {/* The weight on it, as a three-step meter riding the outgoing edge. Two
       * steps lit of three: a vouch has a strength, and it is not always the
       * maximum one. */}
      <g fill="currentColor">
        <rect x="98" y="29" width="4" height="4" />
        <rect x="104" y="27" width="4" height="6" />
        <rect x="110" y="25" width="4" height="8" opacity="0.28" />
      </g>

      {/* Taken back: the same journey, returned, drawn as a path that is not
       * quite there. */}
      <path
        d="M126 45 C 126 68, 96 72, 70 72 S 14 68, 14 45"
        stroke="currentColor"
        strokeWidth="0.9"
        strokeDasharray="3 3"
        opacity="0.45"
      />
      <path
        d="M10 49 L14 43 L18 49"
        stroke="currentColor"
        strokeWidth="0.9"
        opacity="0.45"
      />

      <circle cx="14" cy="38" r="6" fill="currentColor" />
      <circle cx="126" cy="38" r="5" fill="currentColor" opacity="0.75" />
    </Frame>
  )
}

/**
 * 2 · Score. A lit component on the left, an unlit clique on the right, and a
 * gap that nothing crosses.
 *
 * This is the one claim on the page that a sentence alone does not land: "a bot
 * island nobody real vouches for gains nothing from vouching for itself" is
 * abstract until you see every arrow pointing inward and nothing arriving.
 */
export function ScoreFigure({ className }: { className?: string }) {
  // Left: a trusted seed at the top, trust flowing down and out.
  const trusted: Array<[number, number, number]> = [
    [30, 14, 5],
    [14, 38, 4],
    [44, 40, 4.2],
    [8, 62, 3],
    [28, 64, 3.4],
    [50, 66, 3],
  ]
  const trustedEdges: Array<[number, number]> = [
    [0, 1],
    [0, 2],
    [1, 3],
    [1, 4],
    [2, 4],
    [2, 5],
  ]

  // Right: eight nodes, all vouching for each other, nothing arriving.
  const island: Array<[number, number]> = [
    [96, 30],
    [116, 24],
    [130, 38],
    [128, 58],
    [112, 68],
    [94, 62],
    [88, 46],
    [110, 46],
  ]

  return (
    <Frame className={className}>
      {/* The lit component. Edges at full ink, nodes filled by how much trust
       * reached them. */}
      <g stroke="currentColor" strokeWidth="1.1">
        {trustedEdges.map(([from, to]) => (
          <line
            key={`t-${from}-${to}`}
            x1={trusted[from][0]}
            y1={trusted[from][1]}
            x2={trusted[to][0]}
            y2={trusted[to][1]}
          />
        ))}
      </g>
      {trusted.map(([x, y, r], index) => (
        <circle
          key={`n-${index}`}
          cx={x}
          cy={y}
          r={r}
          fill="currentColor"
          opacity={index === 0 ? 1 : 0.92 - index * 0.05}
        />
      ))}

      {/* The gap. Nothing crosses it, which is the entire point, so it gets a
       * dashed hairline to make the absence visible rather than accidental. */}
      <line
        x1="70"
        y1="8"
        x2="70"
        y2="76"
        stroke="currentColor"
        strokeWidth="0.6"
        strokeDasharray="2 4"
        opacity="0.35"
      />

      {/* The island. Every pair joined, every node the same weight, all of it
       * dim: lots of arrows, nothing flowing in. */}
      <g stroke="currentColor" strokeWidth="0.5" opacity="0.2">
        {island.flatMap(([x1, y1], i) =>
          island
            .slice(i + 1)
            .map(([x2, y2], j) => (
              <line key={`i-${i}-${j}`} x1={x1} y1={y1} x2={x2} y2={y2} />
            ))
        )}
      </g>
      {island.map(([x, y], index) => (
        <circle
          key={`b-${index}`}
          cx={x}
          cy={y}
          r="2.6"
          fill="currentColor"
          opacity="0.24"
        />
      ))}
    </Frame>
  )
}

/**
 * 3 · Use. A ranked scoreboard on the left, and three things reading it on the
 * right.
 *
 * The bars are ordered and unequal because a scoreboard is: the point of the
 * third panel is that what comes out the far end is a list with an order to it,
 * and that more than one contract can read the same list.
 */
export function UseFigure({ className }: { className?: string }) {
  const rows: Array<[number, number]> = [
    [16, 58],
    [32, 45],
    [48, 34],
    [64, 25],
  ]

  return (
    <Frame className={className}>
      {/* The proven scoreboard: an account, and how much score it holds. Ranked,
       * because the order is the whole output. */}
      {rows.map(([y, width], index) => (
        <g key={`row-${y}`} opacity={1 - index * 0.16}>
          <circle cx="10" cy={y} r="2.6" fill="currentColor" />
          <rect
            x="18"
            y={y - 2.5}
            width={width}
            height="5"
            fill="currentColor"
          />
        </g>
      ))}

      {/* Committed once, read by anyone, so the edge fans rather than ending. */}
      <g stroke="currentColor" strokeWidth="1" opacity="0.7">
        <path d="M84 40 H94 M94 16 V64 M94 16 H102 M94 40 H102 M94 64 H102" />
        <path d="M98 13 L102 16 L98 19 M98 37 L102 40 L98 43 M98 61 L102 64 L98 67" />
      </g>

      {/* Three contracts reading the same list. Squares, because a contract is
       * not an account, and the panel's claim is that more than one can read it. */}
      <g stroke="currentColor" strokeWidth="1.1" opacity="0.85">
        <rect x="104" y="9" width="34" height="14" />
        <rect x="104" y="33" width="34" height="14" />
        <rect x="104" y="57" width="34" height="14" />
      </g>
    </Frame>
  )
}
