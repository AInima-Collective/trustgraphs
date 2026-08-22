#!/usr/bin/env node
/**
 * Regenerates every brand raster from one source of truth: the ink mark.
 *
 * The old assets were the blue asterisk-person wordmark, which predates the
 * ink-only palette and the trustgraphs name. Everything this writes is drawn
 * from `chord` (see components/BrandMark.tsx) in `--bg` / `--text`, so the tab
 * icon, the install icon, and the share card all show the same thing the nav
 * shows.
 *
 * Run it again whenever the `chord` geometry in components/BrandMark.tsx
 * changes — this file keeps its own copy of the path data (below) because it
 * runs in plain node, outside the bundler:
 *
 *   pnpm run brand:assets
 *
 * Writes:
 *   app/icon.svg              favicon (vector; Next links it automatically)
 *   app/favicon.ico           legacy fallback, 16/32/48 PNG-in-ICO
 *   app/apple-icon.png        180x180 touch icon
 *   app/opengraph-image.png   1200x630 share card
 *   app/twitter-image.png     byte-identical copy of the share card
 *   public/images/icon-192.png, icon-512.png   PWA manifest icons
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ImageResponse } from 'next/og.js'
import wawoff2 from 'wawoff2'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// Straight from app/tokens.css. The dark ramp, because the app is dark-first
// and a tab icon does not get to follow a theme.
const INK = '#0a0b0c'
const PAPER = '#eceef0'
const MUTED = '#a1a5a9'

/**
 * `chord` at its native proportions, straight out of BrandMark: a ring with an
 * inscribed scalene triangle and a node at each vertex. The triangle is
 * deliberately not equilateral — radial symmetry turns the whole thing into a
 * ship's wheel.
 *
 * `strokeScale` thickens the two stroked figures without touching the
 * geometry. The tile needs it; the share card, rendered at 112px, does not.
 */
const chord = (strokeScale = 1) =>
  `<circle cx="16" cy="16" r="13" fill="none" stroke="${PAPER}" stroke-width="${2 * strokeScale}"/>` +
  `<path d="M19.36 3.44 L27.26 22.5 L3.44 19.36 Z" fill="none" stroke="${PAPER}" stroke-width="${2 * strokeScale}"/>` +
  `<circle cx="19.36" cy="3.44" r="3.2" fill="${PAPER}"/>` +
  `<circle cx="27.26" cy="22.5" r="3.2" fill="${PAPER}"/>` +
  `<circle cx="3.44" cy="19.36" r="3.2" fill="${PAPER}"/>`

const markSvg = (size) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}">${chord()}</svg>`

/**
 * The same mark on a filled tile. `chord`'s vertex nodes sit ON the ring, so
 * its true bounding box is x[0.24,30.46] y[0.24,30] — wider than the ring and
 * off-centre. The transform recentres that box and shrinks it to leave a
 * 3-unit margin; the stroke is pre-multiplied by the inverse so it lands back
 * at 2 units, which is 1px at a 16px favicon. Below that the ring and the
 * triangle silt into each other.
 */
const tileSvg = (size) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}">` +
  `<rect width="32" height="32" fill="${INK}"/>` +
  `<g transform="translate(3.72 3.9) scale(0.8)">${chord(1.25)}</g>` +
  `</svg>`

const dataUri = (svg) =>
  `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`

const png = async (element, width, height, options = {}) =>
  Buffer.from(
    await new ImageResponse(element, {
      width,
      height,
      ...options,
    }).arrayBuffer()
  )

/** A square ink tile at `size`, as a PNG. */
const tilePng = (size) =>
  png(
    {
      type: 'div',
      props: {
        style: { display: 'flex', width: '100%', height: '100%' },
        children: {
          type: 'img',
          props: { src: dataUri(tileSvg(size)), width: size, height: size },
        },
      },
    },
    size,
    size
  )

/**
 * PNG-compressed ICO. Every Windows since Vista reads this, and it saves
 * hand-rolling a BMP encoder for three sizes.
 */
const ico = (images) => {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(images.length, 4)

  let offset = 6 + images.length * 16
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size >= 256 ? 0 : size, 0)
    entry.writeUInt8(size >= 256 ? 0 : size, 1)
    entry.writeUInt8(0, 2) // palette
    entry.writeUInt8(0, 3) // reserved
    entry.writeUInt16LE(1, 4) // colour planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += data.length
    return entry
  })

  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)])
}

/**
 * PaperMono ships as woff2, which satori cannot read (no brotli in the
 * bundle), so decompress it here rather than checking a second copy of the
 * face into the repo.
 */
const brandFont = async () =>
  Buffer.from(
    await wawoff2.decompress(
      await readFile(join(ROOT, 'public/fonts/PaperMono-Regular.woff2'))
    )
  )

const shareCard = async (font) =>
  png(
    {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          width: '100%',
          height: '100%',
          background: INK,
          padding: '0 96px',
          fontFamily: 'PaperMono',
        },
        children: [
          {
            type: 'div',
            props: {
              style: { display: 'flex', alignItems: 'center', gap: '36px' },
              children: [
                {
                  type: 'img',
                  props: {
                    src: dataUri(markSvg(112)),
                    width: 112,
                    height: 112,
                  },
                },
                {
                  type: 'div',
                  props: {
                    style: {
                      fontSize: 96,
                      color: PAPER,
                      letterSpacing: '-0.02em',
                    },
                    children: 'Trustgraphs',
                  },
                },
              ],
            },
          },
          {
            type: 'div',
            props: {
              style: { marginTop: '44px', fontSize: 38, color: MUTED },
              children: 'Reputation you can’t buy.',
            },
          },
        ],
      },
    },
    1200,
    630,
    {
      fonts: [{ name: 'PaperMono', data: font, style: 'normal', weight: 400 }],
    }
  )

const main = async () => {
  const font = await brandFont()

  // Vector favicon first: modern browsers prefer it, and it is the only one
  // that stays sharp on a 3x display.
  await writeFile(join(ROOT, 'app/icon.svg'), tileSvg(32) + '\n')

  const [ico16, ico32, ico48, apple, pwa192, pwa512] = await Promise.all([
    tilePng(16),
    tilePng(32),
    tilePng(48),
    tilePng(180),
    tilePng(192),
    tilePng(512),
  ])

  await writeFile(
    join(ROOT, 'app/favicon.ico'),
    ico([
      { size: 16, data: ico16 },
      { size: 32, data: ico32 },
      { size: 48, data: ico48 },
    ])
  )
  await writeFile(join(ROOT, 'app/apple-icon.png'), apple)
  await writeFile(join(ROOT, 'public/images/icon-192.png'), pwa192)
  await writeFile(join(ROOT, 'public/images/icon-512.png'), pwa512)

  // One card, two filenames: Next serves opengraph-image for og:image and
  // twitter-image for twitter:image, and there is no reason for them to differ.
  const card = await shareCard(font)
  await writeFile(join(ROOT, 'app/opengraph-image.png'), card)
  await writeFile(join(ROOT, 'app/twitter-image.png'), card)

  console.log('brand assets written')
}

await main()
