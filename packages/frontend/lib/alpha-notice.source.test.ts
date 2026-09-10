import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * The software is alpha and the interface says so in two places: a tag beside
 * the wordmark on every page, and a caveat on every surface that creates a
 * network. These pins keep both from quietly disappearing in a refactor, and
 * keep the caveat's wording honest against the FAQ answer it points at.
 */
const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), 'utf8')

const nav = read('../components/Nav.tsx')
const notice = read('../components/AlphaNotice.tsx')
const faq = read('../app/faq/page.tsx')

test('the nav carries an alpha tag beside the home link, not inside it', () => {
  // The link's accessible name is the destination; the tag is announced on
  // its own after it.
  assert.match(
    nav,
    /aria-label="Trustgraphs, home"[\s\S]*?<\/Link>\s*<span className="tg-label[^"]*">\s*alpha\s*<\/span>/
  )
  // The tag cannot be the thing that truncates the wordmark at 320px.
  assert.match(nav, /<span className="tg-label[^"]*\bshrink-0\b[^"]*">\s*alpha/)
})

test('the testnet tag follows the alpha tag and only on the Sepolia target', () => {
  // The alpha tag is unconditional: it is true of every deployment.
  assert.match(
    nav,
    /<\/Link>\s*<span className="tg-label[^"]*">\s*alpha\s*<\/span>/
  )
  // The testnet tag is the next sibling and is gated on the build target,
  // not on anything the browser can see.
  assert.match(nav, /import \{ CHAIN \} from '@\/lib\/config'/)
  assert.match(
    nav,
    /alpha\s*<\/span>\s*\{CHAIN === 'sepolia' && \(\s*<span\s+className="tg-label[^"]*\bshrink-0\b[^"]*"\s+title=\{applicationEnvironmentLabel\(CHAIN\)\}\s*>\s*testnet\s*<\/span>\s*\)\}/
  )
  // Sepolia is the only target that gets a chip; mainnet is the default a
  // visitor assumes and local is never public.
  assert.equal((nav.match(/CHAIN === '/g) ?? []).length, 1)
  assert.doesNotMatch(nav, /\bmainnet\s*<\/span>/)
})

test('the caveat says what the software is and what not to do with it', () => {
  assert.match(notice, /role="note"/)
  assert.match(notice, /aria-label="Alpha software"/)
  assert.match(notice, /Trustgraphs is alpha software/)
  assert.match(notice, /large amounts of money/)
  assert.match(notice, /security-critical/)
  // No link: the footer already reaches the FAQ from every page. The audit
  // wording agrees with the Status answer there.
  assert.doesNotMatch(notice, /<Link\b/)
  assert.match(notice, /has not been\s+audited by an outside firm/)
  assert.match(faq, /Not by an outside firm/)
})

test('every surface that creates a network shows the caveat', () => {
  const surfaces = {
    chooser: read('../app/create/chooser.tsx'),
    standard: read('../app/create/component.tsx'),
    imported: read('../app/create/imported/workspace.tsx'),
    weighted: read('../app/create/weighted/workspace.tsx'),
    composition: read('../app/create/composition/workspace.tsx'),
  }
  for (const [name, source] of Object.entries(surfaces)) {
    assert.match(
      source,
      /import \{ AlphaNotice \} from '@\/components\/AlphaNotice'/,
      `${name} imports the notice`
    )
    assert.match(source, /<AlphaNotice \/>/, `${name} renders the notice`)
  }
  // The Settings embeds administer an existing network; they are not a
  // creation and do not get the caveat.
  assert.match(surfaces.weighted, /\{!administrative && <AlphaNotice \/>\}/)
  assert.match(
    surfaces.composition,
    /\{!embedded && mode === 'create' && <AlphaNotice \/>\}/
  )
})
