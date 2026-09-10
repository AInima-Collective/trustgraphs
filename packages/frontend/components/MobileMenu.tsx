'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useId, useRef } from 'react'

import { cn } from '@/lib/utils'

import { ThemeToggle } from './ThemeToggle'

/**
 * The phone menu. Below `md` the nav has room for the wordmark and two
 * controls, so the destinations move behind a menu button and unfold from
 * under the nav rule when it is pressed: the sheet is the same width as the
 * nav, page-coloured, drawn with the same hairlines, and the rest of the
 * page dims behind it. It reads as the nav opening rather than as a panel
 * arriving from somewhere else.
 *
 * Two kinds of row. The two destinations that must not be confused
 * (`Networks` is the directory, `Create a network` starts one) are set at the
 * h3 step of the display serif with one plain line under each saying what it
 * is. The reading routes below them are mono labels, and the last row carries
 * the theme toggle, which is the one control the nav gives up on a phone to
 * stay one row tall.
 *
 * It is a disclosure, not a modal dialog: the button says what it controls and
 * whether it is open, the wordmark and the wallet button above the sheet keep
 * working, and Tab cycles through the button and the sheet. Escape, the dimmed
 * page, a route change and growing past `md` all close it, and closing gives
 * focus back to the button.
 *
 * LAYERING. The sheet is `absolute` off the nav row and the scrim is `fixed`,
 * and both live inside the nav so the row paints above the scrim and the
 * sheet hangs from exactly the row's bottom padding edge, which is where the
 * nav draws its rule. `Nav.tsx` owns the open state because it has to raise
 * itself above the page while the menu is open.
 */

/** Tailwind's `md`: where the nav shows its links inline and this menu retires. */
const INLINE_NAV_QUERY = '(min-width: 48rem)'

const FOCUSABLE =
  'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'

type Destination = {
  href: string
  label: string
  description?: string
}

const DESTINATIONS: Destination[] = [
  {
    href: '/networks',
    label: 'Networks',
    description: 'Browse the directory of trust networks.',
  },
  {
    href: '/create',
    label: 'Create a network',
    description: 'Start a new trust network.',
  },
]

const READING: Destination[] = [
  { href: '/docs', label: 'Docs' },
  { href: '/faq', label: 'FAQ' },
]

const isCurrent = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`)

export interface MobileMenuProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  className?: string
}

export function MobileMenu({ open, onOpenChange, className }: MobileMenuProps) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const pathname = usePathname()

  // A destination was chosen (or the reader navigated some other way).
  useEffect(() => {
    onOpenChange(false)
  }, [pathname, onOpenChange])

  // Growing past `md` hides the sheet with CSS; this also releases the scroll
  // lock and the raised nav, which CSS cannot.
  useEffect(() => {
    const query = window.matchMedia(INLINE_NAV_QUERY)
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) onOpenChange(false)
    }
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [onOpenChange])

  // Hold the page still behind the sheet. Same recipe as `Modal.tsx`: pinning
  // the body keeps iOS from scrolling the document under the scrim, and the
  // saved offset puts the reader back where they were on close.
  useEffect(() => {
    if (!open) return
    const scrollX = window.scrollX
    const scrollY = window.scrollY
    const width = document.documentElement.clientWidth
    const body = document.body
    body.style.position = 'fixed'
    body.style.top = `-${scrollY}px`
    body.style.left = `-${scrollX}px`
    body.style.width = `${width}px`
    return () => {
      body.style.position = ''
      body.style.top = ''
      body.style.left = ''
      body.style.width = ''
      window.scrollTo(scrollX, scrollY)
    }
  }, [open])

  // The sheet is content-sized and hangs below the nav, so on a short screen
  // (a phone held sideways) it has to scroll inside itself rather than run off
  // the bottom of a page that can no longer scroll. `offsetTop` rather than
  // the panel's own rect: the rect includes the entrance transform.
  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    const anchor = panel?.offsetParent
    if (!panel || !(anchor instanceof HTMLElement)) return
    const fit = () => {
      const viewport = window.visualViewport
      const bottom =
        (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight)
      const top = anchor.getBoundingClientRect().top + panel.offsetTop
      panel.style.maxHeight = `${Math.max(0, bottom - top)}px`
    }
    fit()
    window.addEventListener('resize', fit)
    window.visualViewport?.addEventListener('resize', fit)
    return () => {
      window.removeEventListener('resize', fit)
      window.visualViewport?.removeEventListener('resize', fit)
    }
  }, [open])

  // Focus goes to the first destination on open and back to the button on
  // close. Tab cycles button → rows → button: the page behind the scrim is
  // not part of the cycle, and the way out is Escape or the button itself.
  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE)
    const frame = requestAnimationFrame(() =>
      (first ?? panel)?.focus({ preventScroll: true })
    )
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onOpenChange(false)
        return
      }
      if (event.key !== 'Tab' || !panel) return
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (items.length === 0) return
      const button = buttonRef.current
      const active = document.activeElement
      const last = items[items.length - 1]
      if (event.shiftKey) {
        if (active === items[0]) {
          event.preventDefault()
          button?.focus()
        } else if (active === button) {
          event.preventDefault()
          last.focus()
        }
      } else if (active === last) {
        event.preventDefault()
        button?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKeyDown)
      const active = document.activeElement
      if (!active || active === document.body || panel?.contains(active)) {
        buttonRef.current?.focus({ preventScroll: true })
      }
    }
  }, [open, onOpenChange])

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={open ? 'Close menu' : 'Menu'}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => onOpenChange(!open)}
        className={cn(
          // The same 44px hairline square as the theme toggle it stands in for.
          'inline-flex h-11 w-11 shrink-0 items-center justify-center border transition-colors',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink',
          open
            ? 'border-hairline-strong text-text'
            : 'border-border text-text-muted hover:border-hairline-strong hover:text-text',
          className
        )}
      >
        <MenuGlyph open={open} />
      </button>

      <div
        id={panelId}
        ref={panelRef}
        tabIndex={-1}
        inert={!open}
        aria-hidden={!open || undefined}
        className={cn(
          'absolute inset-x-0 top-full overflow-y-auto overscroll-contain border-t border-border bg-background',
          'transition-[opacity,visibility] duration-200 md:hidden',
          open
            ? 'visible opacity-100 animate-in fade-in-0 slide-in-from-top-1'
            : 'invisible opacity-0 pointer-events-none'
        )}
      >
        <ul className="flex flex-col pl-0 list-none">
          {DESTINATIONS.map(({ href, label, description }) => {
            const current = isCurrent(pathname, href)
            return (
              <li key={href}>
                <Link
                  href={href}
                  prefetch={false}
                  aria-current={current ? 'page' : undefined}
                  className={cn(
                    'flex min-h-16 flex-col justify-center gap-0.5 border-b border-border py-3 pr-2',
                    'transition-opacity active:opacity-70',
                    'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink'
                  )}
                >
                  <span className="flex items-center gap-3">
                    <span className="tg-display text-[length:calc(var(--text-xl)*var(--display-scale))] text-text">
                      {label}
                    </span>
                    {current && <CurrentMarker />}
                  </span>
                  {description && (
                    <span className="text-xs text-text-subtle">
                      {description}
                    </span>
                  )}
                </Link>
              </li>
            )
          })}
          {READING.map(({ href, label }) => {
            const current = isCurrent(pathname, href)
            return (
              <li key={href}>
                <Link
                  href={href}
                  prefetch={false}
                  aria-current={current ? 'page' : undefined}
                  className={cn(
                    'flex min-h-12 items-center gap-3 border-b border-border pr-2 text-xs uppercase tracking-wider',
                    'transition-colors active:opacity-70',
                    current ? 'text-text' : 'text-text-muted hover:text-text',
                    'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink'
                  )}
                >
                  {label}
                  {current && <CurrentMarker />}
                </Link>
              </li>
            )
          })}
        </ul>

        <div className="flex min-h-14 items-center justify-between gap-3 border-b border-border py-2">
          <span className="tg-label">Theme</span>
          <ThemeToggle />
        </div>
      </div>
    </>
  )
}

/**
 * The page behind the open sheet. Rendered by `Nav.tsx` as a sibling of the
 * nav row rather than inside it, so the row's own stacking layer sits above
 * it and stays bright and clickable. Tapping it closes the menu.
 */
export function MobileMenuScrim({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  return (
    <div
      aria-hidden="true"
      onClick={onClose}
      className={cn(
        'tg-scrim fixed inset-0 z-10 transition-[opacity,visibility] duration-200 md:hidden',
        open ? 'visible opacity-100' : 'invisible opacity-0 pointer-events-none'
      )}
    />
  )
}

/** The chord's solid node, marking the row the reader is already on. */
const CurrentMarker = () => (
  <span
    aria-hidden="true"
    className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-ink"
  />
)

/**
 * Three hairlines that fold into a cross. Same 16px box, 1.5 stroke and
 * 240ms as the theme toggle's coin, so the two controls read as a pair. The
 * outer lines travel to the middle and turn 45°; the middle one collapses.
 * `transform-origin` is in user units because SVG resolves it against the
 * viewBox, not the element.
 */
function MenuGlyph({ open }: { open: boolean }) {
  const transition = 'transform 240ms ease, opacity 240ms ease'
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <line
        x1="1"
        y1="3.5"
        x2="15"
        y2="3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        style={{
          transition,
          transformOrigin: '8px 3.5px',
          transform: open
            ? 'translateY(4.5px) rotate(45deg) scaleX(1.2)'
            : 'none',
        }}
      />
      <line
        x1="1"
        y1="8"
        x2="15"
        y2="8"
        stroke="currentColor"
        strokeWidth="1.5"
        style={{
          transition,
          transformOrigin: '8px 8px',
          transform: open ? 'scaleX(0)' : 'none',
          opacity: open ? 0 : 1,
        }}
      />
      <line
        x1="1"
        y1="12.5"
        x2="15"
        y2="12.5"
        stroke="currentColor"
        strokeWidth="1.5"
        style={{
          transition,
          transformOrigin: '8px 12.5px',
          transform: open
            ? 'translateY(-4.5px) rotate(-45deg) scaleX(1.2)'
            : 'none',
        }}
      />
    </svg>
  )
}
