import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { DOCS_ORDER } from './manifest'

const DOCS_DIR = path.resolve(process.cwd(), '..', '..', 'docs')

const markdownSlugs = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return markdownSlugs(entryPath)
    if (!entry.name.endsWith('.md')) return []

    const relative = path
      .relative(DOCS_DIR, entryPath)
      .split(path.sep)
      .join('/')
    return relative === 'README.md' ? [] : [relative.slice(0, -3)]
  })

test('every documentation source has exactly one public route', () => {
  const routes = DOCS_ORDER.map(({ slug }) => slug).sort()
  const sources = markdownSlugs(DOCS_DIR).sort()

  assert.equal(new Set(routes).size, routes.length, 'duplicate docs route')
  assert.deepEqual(routes, sources)
})
