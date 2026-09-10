import { cn } from '@/lib/utils'

/**
 * The alpha caveat, shown wherever a network gets created: the chooser and
 * each of the creation workspaces, since every one of them has its own URL
 * and a reader can arrive at any of them first.
 *
 * Two sentences: what state the software is in, and what not to do with it.
 * No link. The FAQ's Status group is where the caveats are spelled out and
 * the footer reaches it from every page, so this does not repeat them; the
 * wording of the audit line matches that answer ("Not by an outside firm").
 *
 * Drawn as the same hairline box as `DraftNotice`, with the mono label doing
 * the work a coloured banner would do elsewhere: this system has no warning
 * hue, so the tag carries the emphasis.
 */
export const AlphaNotice = ({ className }: { className?: string }) => (
  <div
    role="note"
    aria-label="Alpha software"
    className={cn(
      'flex flex-col gap-1.5 border border-border px-4 py-3 sm:flex-row sm:items-baseline sm:gap-4',
      className
    )}
  >
    <span className="tg-label-strong shrink-0">Alpha</span>
    <p className="text-sm text-text-muted">
      Trustgraphs is alpha software. It is still changing and has not been
      audited by an outside firm, so do not use it with large amounts of money
      or for anything security-critical.
    </p>
  </div>
)
