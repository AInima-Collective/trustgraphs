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
        d="M20 38 H46 M92 38 H125"
        stroke="currentColor"
        strokeWidth="1.1"
        opacity="0.8"
      />
      <path
        d="M121 34 L127 38 L121 42"
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
        d="M133 45 C 133 68, 96 72, 70 72 S 14 68, 14 45"
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
      <circle cx="133" cy="38" r="5" fill="currentColor" opacity="0.75" />
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
    [11, 62, 3],
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
    [135, 38],
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
 * 3 · Use. A ranked scoreboard on the left, and three concrete uses reading it
 * on the right: voting power, incentive distribution, and gated chat access.
 *
 * The bars are ordered and unequal because a scoreboard is. The endpoints are
 * named as well as drawn because three anonymous contract boxes only showed
 * that scores were composable, not what that composition was for.
 */
export function UseFigure({ className }: { className?: string }) {
  const rows: Array<[number, number]> = [
    [18, 43],
    [32, 35],
    [46, 27],
    [60, 20],
  ]

  return (
    <Frame className={className}>
      {/* The proven scoreboard: an account, and how much score it holds. Ranked,
       * because the order is the whole output. */}
      {rows.map(([y, width], index) => (
        <g key={`row-${y}`} opacity={1 - index * 0.16}>
          <circle cx="7.6" cy={y} r="2.6" fill="currentColor" />
          <rect
            x="14"
            y={y - 2.5}
            width={width}
            height="5"
            fill="currentColor"
          />
        </g>
      ))}

      {/* Committed once, read by anyone, so the edge fans rather than ending. */}
      <g stroke="currentColor" strokeWidth="1" opacity="0.7">
        <path d="M60 42 H70 M70 16 V68 M70 16 H81 M70 42 H81 M70 68 H81" />
        <path d="M77 13 L81 16 L77 19 M77 39 L81 42 L77 45 M77 65 L81 68 L77 71" />
      </g>

      {/* Three applications reading the same scores. Each box gets both a
       * distinct glyph and a short label: the meaning survives at a glance,
       * while the labels keep it from turning into icon guesswork. */}
      <g stroke="currentColor" strokeWidth="1" opacity="0.85">
        <rect x="83" y="7" width="61" height="18" />
        <rect x="83" y="33" width="61" height="18" />
        <rect x="83" y="59" width="61" height="18" />
      </g>

      {/* Voting: a marked ballot. */}
      <g stroke="currentColor" strokeWidth="1" opacity="0.9">
        <rect x="88" y="12" width="8" height="8" />
        <path d="M89.5 15.5 L91.5 17.5 L95.5 12.5" />
      </g>

      {/* Incentives: a small distribution from one pool to two recipients. */}
      <g stroke="currentColor" strokeWidth="0.9" opacity="0.9">
        <circle cx="92" cy="38.5" r="2" />
        <circle cx="88.5" cy="46.5" r="2" />
        <circle cx="95.5" cy="46.5" r="2" />
        <path d="M92 40.5 V43 M92 43 H88.5 V44.5 M92 43 H95.5 V44.5" />
      </g>

      {/* Gated chat: a speech bubble closed with a small keyhole. */}
      <g stroke="currentColor" strokeWidth="0.9" opacity="0.9">
        <path d="M87.5 64 H96.5 V70 H92 L89 72 V70 H87.5 Z" />
        <circle cx="92" cy="66.5" r="0.8" />
        <path d="M92 67.3 V68.5" />
      </g>

      <g
        fill="currentColor"
        fontFamily="var(--mono-family)"
        fontSize="4.4"
        letterSpacing="0.15"
        opacity="0.85"
      >
        <text x="101" y="17.6">
          VOTING POWER
        </text>
        <text x="101" y="43.6">
          INCENTIVES
        </text>
        <text x="101" y="69.6">
          GATED CHAT
        </text>
      </g>
    </Frame>
  )
}
