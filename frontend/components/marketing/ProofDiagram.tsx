import { cn } from '@/lib/utils'

/**
 * The one diagram on the landing page: vouches in, one proof out, the chain
 * checks the proof by itself — and the path that gets rejected drawn underneath,
 * because the rejection is the part that makes the rest worth anything.
 *
 * Built as laid-out HTML with small inline glyphs rather than one wide SVG. A
 * single fixed-aspect drawing either scales its labels down to unreadable on a
 * phone or scrolls sideways; this reflows to a column instead, and its labels
 * are real text — findable, selectable, translatable, and already in the
 * accessibility tree before anyone writes an alt attribute.
 *
 * Ink only, except the rejected branch, which spends the one colour the system
 * allows for "the protocol is telling you something". It does not rely on that
 * colour: the arrow is broken and struck through, so the meaning survives in
 * grayscale and for anyone who cannot separate the two.
 *
 * Copy lives in LANDING_PAGE_COPY.md under "The proof".
 */

const Glyph = ({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) => (
  <svg
    viewBox="0 0 32 32"
    className={cn('h-11 w-11 shrink-0', className)}
    fill="none"
    aria-hidden="true"
    focusable="false"
  >
    {children}
  </svg>
)

/** Three accounts, two vouches. The input set. */
const VouchesGlyph = ({ struck = false }: { struck?: boolean }) => (
  <Glyph>
    <path
      d="M9 9 L23 16 M23 16 L9 23"
      stroke="currentColor"
      strokeWidth="1.5"
      opacity={struck ? 0.4 : 1}
    />
    <circle cx="7" cy="8" r="3" fill="currentColor" />
    <circle cx="7" cy="24" r="3" fill="currentColor" />
    <circle cx="25" cy="16" r="3" fill="currentColor" />
    {struck && (
      <path d="M4 28 L28 4" stroke="currentColor" strokeWidth="1.75" />
    )}
  </Glyph>
)

/** The receipt: short, torn off, and the same shape whatever it attests to. */
const ProofGlyph = () => (
  <Glyph>
    <path
      d="M7 4 H25 V25 L22 27.5 L19 25 L16 27.5 L13 25 L10 27.5 L7 25 Z"
      stroke="currentColor"
      strokeWidth="1.5"
    />
    <path
      d="M11 11 H21 M11 16 H21 M11 21 H17"
      stroke="currentColor"
      strokeWidth="1.5"
    />
  </Glyph>
)

/**
 * The receipt that does not exist: the same shape, drawn as an outline with
 * nothing written on it.
 *
 * The rejected row needs a figure for the same reason the accepted row does. A
 * box with a line of text in it next to two boxes with drawings in them reads
 * as an unfinished panel rather than as the punchline.
 */
const NoProofGlyph = () => (
  <Glyph className="text-error">
    <path
      d="M7 4 H25 V25 L22 27.5 L19 25 L16 27.5 L13 25 L10 27.5 L7 25 Z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeDasharray="3 3"
      opacity="0.7"
    />
    <path d="M9 6 L23 26" stroke="currentColor" strokeWidth="1.75" />
  </Glyph>
)

/** Blocks, in order, each holding the one before it. */
const ChainGlyph = () => (
  <Glyph>
    <rect
      x="4"
      y="6"
      width="10"
      height="10"
      stroke="currentColor"
      strokeWidth="1.5"
    />
    <rect
      x="18"
      y="6"
      width="10"
      height="10"
      stroke="currentColor"
      strokeWidth="1.5"
    />
    <rect
      x="11"
      y="19"
      width="10"
      height="9"
      stroke="currentColor"
      strokeWidth="1.5"
    />
    <path
      d="M14 11 H18 M9 16 V19 H11 M23 16 V19 H21"
      stroke="currentColor"
      strokeWidth="1.5"
    />
  </Glyph>
)

/**
 * Horizontal on a wide screen, vertical once the row becomes a column.
 *
 * `invisible` renders one that occupies its track without drawing: the rejected
 * row has one connector to the accepted row's two, and letting `flex-1` sort
 * that out put every box in row 2 twenty-seven pixels off the column above it,
 * at exactly the width where the thing starts reading as a diagram.
 */
const Connector = ({
  broken = false,
  hidden = false,
}: {
  broken?: boolean
  hidden?: boolean
}) => (
  <div
    className={cn(
      'flex items-center justify-center self-center py-1 md:px-1 md:py-0',
      hidden && 'invisible hidden md:flex',
      broken ? 'text-error' : 'text-text-subtle'
    )}
    aria-hidden="true"
  >
    <svg
      viewBox="0 0 40 12"
      className="hidden h-3 w-10 md:block"
      fill="none"
      focusable="false"
    >
      <path
        d="M0 6 H30"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeDasharray={broken ? '4 4' : undefined}
      />
      <path
        d="M28 2 L34 6 L28 10"
        stroke="currentColor"
        strokeWidth="1.25"
        fill="none"
      />
      {/* A cross on the line, not a slash through it. The single diagonal read
       * as a stray tick at the size this actually renders. */}
      {broken && (
        <path
          d="M12 2 L20 10 M20 2 L12 10"
          stroke="currentColor"
          strokeWidth="1.25"
        />
      )}
    </svg>
    <svg
      viewBox="0 0 12 40"
      className="h-10 w-3 md:hidden"
      fill="none"
      focusable="false"
    >
      <path
        d="M6 0 V30"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeDasharray={broken ? '4 4' : undefined}
      />
      <path
        d="M2 28 L6 34 L10 28"
        stroke="currentColor"
        strokeWidth="1.25"
        fill="none"
      />
      {broken && (
        <path
          d="M2 12 L10 20 M10 12 L2 20"
          stroke="currentColor"
          strokeWidth="1.25"
        />
      )}
    </svg>
  </div>
)

const Stage = ({
  glyph,
  label,
  tone = 'default',
}: {
  glyph: React.ReactNode
  label: string
  tone?: 'default' | 'muted'
}) => (
  <div
    className={cn(
      'flex flex-col items-center gap-3 border p-4 text-center md:min-h-[8.5rem] md:justify-center',
      tone === 'muted'
        ? 'border-hairline text-text-subtle'
        : 'border-hairline-strong text-text'
    )}
  >
    {glyph}
    <span className="leading-snug text-balance">{label}</span>
  </div>
)

/**
 * Both rows, on identical tracks.
 *
 * A GRID, not a flex row. `flex-1` is `flex: 1 1 0%` but it still respects each
 * item's min-content width, so the two rows measured 379/379/379 against
 * 390/390/356 and every box in the rejected row sat eleven pixels off the one
 * above it — in a diagram whose entire argument is that the second row is the
 * first row with something changed. `minmax(0, 1fr)` splits the free space by
 * track rather than by content, so the columns agree no matter what is in them.
 */
const ROW =
  'flex flex-col md:grid md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] md:items-stretch'

export function ProofDiagram({ className }: { className?: string }) {
  return (
    <figure className={cn('flex flex-col gap-10 md:gap-4', className)}>
      <div className={ROW}>
        <Stage glyph={<VouchesGlyph />} label="Every vouch in the round" />
        <Connector />
        <Stage glyph={<ProofGlyph />} label="One short proof" />
        <Connector />
        <Stage glyph={<ChainGlyph />} label="The chain checks the proof" />
      </div>

      <div className={ROW}>
        <Stage
          tone="muted"
          glyph={<VouchesGlyph struck />}
          label="A vouch dropped, or one invented"
        />
        <Connector broken />
        <div className="flex flex-col items-center justify-center gap-3 border border-error/40 p-4 text-center md:min-h-[8.5rem]">
          <NoProofGlyph />
          <span className="leading-snug text-error text-balance">
            No proof exists to check
          </span>
        </div>
        {/* The rejected path stops at two boxes, but the row still has three
         * columns to fill, so the third is held open and left empty. */}
        <Connector hidden />
        <div className="hidden md:block" aria-hidden="true" />
      </div>

      <figcaption className="max-w-prose text-text-muted">
        The vouches go in, one short proof comes out, and the chain checks the
        proof by itself. Change the vouches and there is no proof to check.
      </figcaption>
    </figure>
  )
}
