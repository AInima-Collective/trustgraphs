import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * The phone nav is a menu button and a sheet that unfolds from under the nav
 * rule; the inline links come back at `md`. These pins keep the two halves
 * agreeing about that breakpoint and keep the sheet's behaviours (scroll
 * lock, focus cycle, closing on route change, escape, scrim, and growing past
 * `md`) from quietly disappearing in a refactor. See `components/MobileMenu.tsx`.
 */
const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), 'utf8')

const nav = read('../components/Nav.tsx')
const menu = read('../components/MobileMenu.tsx')

test('the nav is one row: links inline from md, a menu button below it', () => {
  assert.match(nav, /<MobileMenuScrim open=\{menuOpen\}/)
  assert.match(nav, /<MobileMenu\s+open=\{menuOpen\}/)
  assert.match(nav, /className="md:hidden"/)
  // The inline link group only exists from md; below it the sheet carries
  // the same two destinations.
  assert.match(nav, /className="ml-auto hidden md:flex md:gap-2"/)
  assert.match(nav, /href="\/networks"[\s\S]*?Networks/)
  assert.match(nav, /href="\/create"[\s\S]*?Create a network/)
  // The theme toggle leaves the row on a phone and lives in the sheet.
  assert.match(nav, /<ThemeToggle className="hidden md:inline-flex" \/>/)
  assert.match(menu, /<ThemeToggle \/>/)
  // The nav only raises itself while the menu is open.
  assert.match(nav, /menuOpen && 'z-50'/)
  // The sheet hangs from the row's padding edge, so the row owns the padding.
  assert.match(
    nav,
    /relative z-20 flex flex-row items-center bg-background pb-2 md:pb-4/
  )
  assert.doesNotMatch(nav, /<nav[^>]*pb-\d/)
})

test('the sheet carries both destinations and the reading routes', () => {
  assert.match(menu, /href: '\/networks'/)
  assert.match(menu, /href: '\/create'/)
  assert.match(menu, /href: '\/docs'/)
  assert.match(menu, /href: '\/faq'/)
  assert.match(menu, /label: 'Create a network'/)
  // Every link in the sheet opts out of prefetch, same as the inline nav.
  const links = menu.match(/<Link\b/g) ?? []
  const noPrefetch = menu.match(/prefetch=\{false\}/g) ?? []
  assert.equal(links.length, noPrefetch.length)
  assert.ok(links.length >= 2)
  assert.match(menu, /aria-current=\{current \? 'page' : undefined\}/)
})

test('the menu is a disclosure with the behaviours a sheet needs', () => {
  assert.match(menu, /aria-expanded=\{open\}/)
  assert.match(menu, /aria-controls=\{panelId\}/)
  assert.match(menu, /aria-label=\{open \? 'Close menu' : 'Menu'\}/)
  // 44px target, like the theme toggle it replaces on the row.
  assert.match(menu, /'inline-flex h-11 w-11 shrink-0/)
  // Breakpoint agreement: CSS hides the sheet from md, and a listener on the
  // same query releases the scroll lock and the raised nav.
  assert.match(menu, /INLINE_NAV_QUERY = '\(min-width: 48rem\)'/)
  assert.match(menu, /window\.matchMedia\(INLINE_NAV_QUERY\)/)
  assert.match(
    menu,
    /'transition-\[opacity,visibility\] duration-200 md:hidden'/
  )
  assert.match(menu, /tg-scrim fixed inset-0 z-10[^']*md:hidden/)
  // Closes on route change, escape and the scrim.
  assert.match(menu, /usePathname\(\)/)
  assert.match(menu, /\[pathname, onOpenChange\]/)
  assert.match(menu, /event\.key === 'Escape'/)
  assert.match(menu, /onClick=\{onClose\}/)
  // Scroll lock and restore, the Modal recipe.
  assert.match(menu, /body\.style\.position = 'fixed'/)
  assert.match(menu, /window\.scrollTo\(scrollX, scrollY\)/)
  // Closed sheet is out of the tab order and the accessibility tree.
  assert.match(menu, /inert=\{!open\}/)
  assert.match(menu, /aria-hidden=\{!open \|\| undefined\}/)
  // Focus cycle: first row on open, back to the button on close.
  assert.match(
    menu,
    /\(first \?\? panel\)\?\.focus\(\{ preventScroll: true \}\)/
  )
  assert.match(menu, /buttonRef\.current\?\.focus\(\{ preventScroll: true \}\)/)
})
