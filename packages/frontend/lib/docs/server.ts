import fs from 'fs'
import path from 'path'

import { Marked } from 'marked'

import { DOCS_ORDER, DOCS_SECTIONS, REPO_URL } from './manifest'

/**
 * Server side of the docs: reads `docs/**.md` from the repo root and renders
 * it to HTML that `.tg-prose` (app/docs/docs.css) styles.
 *
 * THE REPO TREE IS THE CMS. There is no copied content and no frontmatter:
 * the page title is the file's own `# H1`, the description is its first
 * paragraph, and a link written `../concepts/algorithm.md` in the file
 * becomes `/docs/concepts/algorithm` here and stays a working relative link
 * on GitHub. Anything a link points at that is NOT a docs page (research/,
 * contracts, test vectors) resolves to the file on GitHub instead — the docs
 * cite the code they document, and those citations must not 404.
 *
 * `docs/` sits two directories above the frontend, so deployments that trace
 * files must carry it: see `outputFileTracingIncludes` in next.config.mjs.
 */

const DOCS_DIR = (() => {
  // cwd is `packages/frontend/` under both `next dev` and `next start`; the standalone
  // server runs from a traced tree that preserves the same relative layout.
  const candidates = [
    path.join(process.cwd(), '..', '..', 'docs'),
    path.join(process.cwd(), 'docs'),
  ]
  return (
    candidates.find((dir) => fs.existsSync(path.join(dir, 'README.md'))) ??
    candidates[0]
  )
})()

const DOC_SLUGS = new Set(DOCS_ORDER.map((item) => item.slug))
const SECTION_DIRS = new Set(DOCS_SECTIONS.map((section) => section.dir))

export type TocEntry = { id: string; text: string; depth: 2 | 3 }

export type RenderedDoc = {
  slug: string
  /** The file's own H1. */
  title: string
  /** First plain paragraph, markdown stripped — standfirst and share card. */
  description: string
  /** Body HTML, H1 removed (the page renders the title itself). */
  html: string
  toc: TocEntry[]
  /** Repo-relative path, for the "view source" link. */
  sourcePath: string
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/**
 * GitHub's heading-slug algorithm, close enough to keep the fragment links
 * the docs already carry (written against GitHub rendering) landing here too:
 * lowercase, drop everything but word characters, spaces and hyphens, then
 * hyphenate the spaces. Duplicates get `-1`, `-2`, … suffixes.
 */
const githubSlug = (text: string, seen: Map<string, number>): string => {
  const base = text
    .toLowerCase()
    .trim()
    .replace(/[^\w\- ]+/g, '')
    .replace(/ +/g, '-')
  const count = seen.get(base) ?? 0
  seen.set(base, count + 1)
  return count === 0 ? base : `${base}-${count}`
}

/** Inline markdown → plain text, for TOC entries and descriptions. */
const stripInline = (markdown: string): string =>
  markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Where a relative link in `docFile` (repo-relative, e.g. `docs/learn/faq.md`)
 * actually goes. Docs pages route internally; everything else goes to the
 * file on GitHub — `blob` for files, `tree` for directories.
 */
export const resolveDocHref = (
  href: string,
  docFile: string
): { href: string; external: boolean } => {
  if (/^(https?:|mailto:)/.test(href)) return { href, external: true }
  if (href.startsWith('#')) return { href, external: false }

  const [target, fragment] = href.split('#')
  const suffix = fragment ? `#${fragment}` : ''
  const resolved = path.posix
    .normalize(path.posix.join(path.posix.dirname(docFile), target))
    .replace(/\/+$/, '')

  if (resolved.startsWith('docs/')) {
    const inner = resolved.slice('docs/'.length)
    if (inner === 'README.md')
      return { href: `/docs${suffix}`, external: false }
    const slug = inner.replace(/\.md$/, '')
    if (DOC_SLUGS.has(slug) || SECTION_DIRS.has(slug)) {
      return { href: `/docs/${slug}${suffix}`, external: false }
    }
  } else if (resolved === 'docs') {
    return { href: `/docs${suffix}`, external: false }
  }

  // Off the docs tree (or a docs file this app does not serve): cite GitHub.
  // A path with an extension is a file; without one it is a directory.
  const kind = path.posix.extname(resolved) ? 'blob' : 'tree'
  return {
    href: `${REPO_URL}/${kind}/HEAD/${resolved}${suffix}`,
    external: true,
  }
}

/**
 * One Marked instance per document: the renderer closes over per-document
 * state (heading-slug dedupe, the TOC being collected, the file the links
 * resolve against), so sharing an instance across renders would leak it.
 */
const renderMarkdown = (
  markdown: string,
  docFile: string
): { html: string; toc: TocEntry[] } => {
  const toc: TocEntry[] = []
  const seenSlugs = new Map<string, number>()

  const marked = new Marked({ gfm: true })
  marked.use({
    renderer: {
      heading(token) {
        const text = this.parser.parseInline(token.tokens)
        const plain = stripInline(token.text)
        const id = githubSlug(plain, seenSlugs)
        if (token.depth === 2 || token.depth === 3) {
          toc.push({ id, text: plain, depth: token.depth })
        }
        // The trailing # appears on hover/focus (docs.css) and gives every
        // section a copyable deep link without cluttering the resting page.
        return `<h${token.depth} id="${id}">${text}<a class="tg-anchor" href="#${id}" aria-label="Link to this section">#</a></h${token.depth}>\n`
      },
      link(token) {
        const text = this.parser.parseInline(token.tokens)
        const { href, external } = resolveDocHref(token.href, docFile)
        const rel = external ? ' target="_blank" rel="noopener noreferrer"' : ''
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : ''
        return `<a href="${escapeHtml(href)}"${title}${rel}>${text}</a>`
      },
      // Tables scroll inside their own box instead of widening the page —
      // several runbooks carry env-var tables far wider than 72ch.
      table(token) {
        const renderCell = (cell: any, tag: 'th' | 'td') => {
          const align = cell.align ? ` style="text-align:${cell.align}"` : ''
          return `<${tag}${align}>${this.parser.parseInline(cell.tokens)}</${tag}>`
        }
        const head = `<tr>${token.header.map((cell: any) => renderCell(cell, 'th')).join('')}</tr>`
        const body = token.rows
          .map(
            (row: any) =>
              `<tr>${row.map((cell: any) => renderCell(cell, 'td')).join('')}</tr>`
          )
          .join('\n')
        return `<div class="tg-table-scroll"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>\n`
      },
      // The docs are markdown, not HTML: anything that parses as an inline
      // tag is almost certainly an unfenced `<placeholder>`, and passing it
      // through raw would make the browser swallow it silently. Escaped, it
      // renders as the text the author wrote.
      html(token) {
        return escapeHtml(token.text)
      },
    },
  })

  const html = marked.parse(markdown, { async: false }) as string
  return { html, toc }
}

const readDocFile = (
  slug: string
): { raw: string; sourcePath: string } | null => {
  // Slugs come from the manifest or generateStaticParams, never free-form —
  // but hold the invariant locally anyway: no separators, no traversal.
  if (!/^[a-z0-9-]+(\/[a-z0-9-]+)*$/.test(slug)) return null
  const sourcePath = `docs/${slug}.md`
  const filePath = path.join(DOCS_DIR, `${slug}.md`)
  if (!fs.existsSync(filePath)) return null
  return { raw: fs.readFileSync(filePath, 'utf8'), sourcePath }
}

const extractTitle = (markdown: string): { title: string; body: string } => {
  const match = markdown.match(/^# (.+)\n?/m)
  if (!match) return { title: '', body: markdown }
  return {
    title: stripInline(match[1]),
    body:
      markdown.slice(0, match.index) +
      markdown.slice((match.index ?? 0) + match[0].length),
  }
}

const extractDescription = (body: string): string => {
  for (const block of body.split(/\n{2,}/)) {
    const line = block.trim()
    if (!line) continue
    // Skip anything that is not a plain paragraph.
    if (/^([#>|`\-*]|\d+\.|\[|!\[|={3,})/.test(line)) continue
    const text = stripInline(line.replace(/\n/g, ' '))
    if (text.length < 8) continue
    return text.length > 200 ? `${text.slice(0, 197).trimEnd()}…` : text
  }
  return ''
}

export const getDoc = (slug: string): RenderedDoc | null => {
  const file = readDocFile(slug)
  if (!file) return null
  const { title, body } = extractTitle(file.raw)
  const { html, toc } = renderMarkdown(body, file.sourcePath)
  return {
    slug,
    title: title || slug,
    description: extractDescription(body),
    html,
    toc,
    sourcePath: file.sourcePath,
  }
}

/**
 * Title + description without rendering the body — the index pages list
 * every page and only need the summary line. Cached per process: the docs
 * change by deployment, not at runtime.
 */
const summaryCache = new Map<string, { title: string; description: string }>()

export const getDocSummary = (
  slug: string
): { title: string; description: string } | null => {
  const cached = summaryCache.get(slug)
  if (cached) return cached
  const file = readDocFile(slug)
  if (!file) return null
  const { title, body } = extractTitle(file.raw)
  const summary = {
    title: title || slug,
    description: extractDescription(body),
  }
  summaryCache.set(slug, summary)
  return summary
}
