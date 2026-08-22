/**
 * The docs sitemap, in reading order.
 *
 * `docs/` in the repo root is the source of record for every page; this file
 * only decides ORDER and sidebar labels, because a filesystem sorts
 * alphabetically and "what-is-trustgraphs before faq" is an editorial call the
 * filesystem cannot make. Slugs mirror the file paths exactly — the page at
 * `/docs/learn/faq` renders `docs/learn/faq.md` — so adding a doc means adding
 * a file there and one line here.
 *
 * Plain data with no imports, so the client sidebar can use it without
 * dragging `fs` or the markdown pipeline into the bundle. Page titles and
 * descriptions come from the markdown itself at render time (single source of
 * truth); the labels here are sidebar copy, kept short enough for a 13rem
 * column.
 */

export type DocItem = {
  /** Path under /docs, and under docs/ with `.md` appended. */
  slug: string
  /** Sidebar label. Sentence case; the page's own H1 may be longer. */
  label: string
}

export type DocGroup = {
  /**
   * Group label, uppercased by the sidebar. Groups with `collapsible` render
   * as native <details>, closed unless the current page is inside — the four
   * per-program directories are reference depth, not reading order.
   */
  label?: string
  collapsible?: boolean
  items: DocItem[]
}

export type DocSection = {
  /** Directory under docs/, and the first path segment of every slug in it. */
  dir: string
  label: string
  /** One sentence under the section heading on the docs index. */
  blurb: string
  groups: DocGroup[]
}

export const REPO_URL = 'https://github.com/JakeHartnell/trustgraphs'

export const DOCS_SECTIONS: DocSection[] = [
  {
    dir: 'learn',
    label: 'Learn',
    blurb:
      'What trustgraphs is and why it works, for anyone. No jargon, no code.',
    groups: [
      {
        items: [
          { slug: 'learn/what-is-trustgraphs', label: 'What is trustgraphs?' },
          { slug: 'learn/how-scoring-works', label: 'How scoring works' },
          { slug: 'learn/proofs', label: 'Why trust the scores' },
          { slug: 'learn/governance', label: 'How the rules change' },
          { slug: 'learn/limits', label: 'Honest limits' },
          { slug: 'learn/faq', label: 'Questions' },
        ],
      },
    ],
  },
  {
    dir: 'concepts',
    label: 'Concepts',
    blurb: 'How the system fits together, for readers who want the mechanics.',
    groups: [
      {
        items: [
          { slug: 'concepts/architecture', label: 'Architecture' },
          {
            slug: 'concepts/networks-and-programs',
            label: 'Networks and programs',
          },
          { slug: 'concepts/epochs-and-proofs', label: 'Epochs and proofs' },
          { slug: 'concepts/algorithm', label: 'The algorithm' },
        ],
      },
    ],
  },
  {
    dir: 'build',
    label: 'Build',
    blurb:
      'For developers: stand up a network for your community, read its scores from your own app or contract, or run the whole stack yourself.',
    groups: [
      {
        items: [
          { slug: 'build/create-a-network', label: 'Create a network' },
          { slug: 'build/integrate-scores', label: 'Integrate scores' },
          { slug: 'build/setup', label: 'Setup' },
          { slug: 'build/quickstart', label: 'Quickstart' },
        ],
      },
      {
        label: 'Advanced',
        items: [
          { slug: 'build/run-a-prover', label: 'Run a prover' },
          { slug: 'build/production', label: 'Deploy to production' },
          { slug: 'build/add-a-program', label: 'Add a program' },
        ],
      },
      {
        label: 'trust-graph',
        collapsible: true,
        items: [
          { slug: 'build/trust-graph/architecture', label: 'Architecture' },
          { slug: 'build/trust-graph/runbook', label: 'Runbook' },
          { slug: 'build/trust-graph/local-testing', label: 'Local testing' },
        ],
      },
      {
        label: 'signer-sync',
        collapsible: true,
        items: [
          { slug: 'build/signer-sync/architecture', label: 'Architecture' },
          { slug: 'build/signer-sync/runbook', label: 'Runbook' },
        ],
      },
      {
        label: 'hypercerts',
        collapsible: true,
        items: [
          { slug: 'build/hypercerts/architecture', label: 'Architecture' },
          { slug: 'build/hypercerts/runbook', label: 'Runbook' },
          { slug: 'build/hypercerts/local-testing', label: 'Local testing' },
        ],
      },
      {
        label: 'nostr-workspace',
        collapsible: true,
        items: [
          {
            slug: 'build/nostr-workspace/architecture',
            label: 'Architecture',
          },
          { slug: 'build/nostr-workspace/runbook', label: 'Runbook' },
          {
            slug: 'build/nostr-workspace/local-testing',
            label: 'Local testing',
          },
          {
            slug: 'build/nostr-workspace/verification',
            label: 'Verification',
          },
          {
            slug: 'build/nostr-workspace/recovery',
            label: 'Recovery',
          },
          { slug: 'build/nostr-workspace/pilot', label: 'Pilot status' },
        ],
      },
      {
        label: 'contributions',
        collapsible: true,
        items: [
          { slug: 'build/contributions/architecture', label: 'Architecture' },
          { slug: 'build/contributions/interfaces', label: 'Interfaces' },
          { slug: 'build/contributions/runbook', label: 'Runbook' },
          { slug: 'build/contributions/local-testing', label: 'Local testing' },
        ],
      },
      {
        label: 'trust-compose',
        collapsible: true,
        items: [
          { slug: 'build/composition/architecture', label: 'Architecture' },
          {
            slug: 'build/composition/frontend',
            label: 'Preview and provenance UI',
          },
          {
            slug: 'build/composition/operator-indexer',
            label: 'Operator and indexer',
          },
          { slug: 'build/composition/runbook', label: 'Runbook' },
        ],
      },
      {
        label: 'graph lineage',
        collapsible: true,
        items: [
          {
            slug: 'build/graph-lineage/architecture',
            label: 'Architecture',
          },
          { slug: 'build/graph-lineage/runbook', label: 'Runbook' },
          {
            slug: 'build/graph-lineage/local-testing',
            label: 'Local testing',
          },
        ],
      },
      {
        label: 'graph reputation',
        collapsible: true,
        items: [
          {
            slug: 'build/graph-reputation/architecture',
            label: 'Architecture',
          },
          { slug: 'build/graph-reputation/runbook', label: 'Runbook' },
          {
            slug: 'build/graph-reputation/local-testing',
            label: 'Local testing',
          },
        ],
      },
    ],
  },
  {
    dir: 'verify',
    label: 'Verify',
    blurb:
      'Check the work: recompute an epoch from public data and confirm what the chain holds.',
    groups: [
      {
        items: [
          {
            slug: 'verify/reproduce-an-epoch',
            label: 'Reproduce an epoch',
          },
          { slug: 'verify/golden-vectors', label: 'Golden vectors' },
          { slug: 'verify/addresses-and-vkeys', label: 'Addresses and vkeys' },
        ],
      },
    ],
  },
]

/** Every page slug, in reading order — the prev/next spine. */
export const DOCS_ORDER: DocItem[] = DOCS_SECTIONS.flatMap((section) =>
  section.groups.flatMap((group) => group.items)
)

const BY_SLUG = new Map(DOCS_ORDER.map((item) => [item.slug, item]))

export const getDocItem = (slug: string): DocItem | undefined =>
  BY_SLUG.get(slug)

export const getSection = (dir: string): DocSection | undefined =>
  DOCS_SECTIONS.find((section) => section.dir === dir)

/**
 * The "I want to…" rows on the docs index. Mirrors the task table in
 * docs/README.md; if a row changes there, it changes here.
 */
export const DOCS_TASKS: { want: string; slug: string }[] = [
  {
    want: 'understand what this is, without jargon',
    slug: 'learn/what-is-trustgraphs',
  },
  {
    want: 'see how scores are computed and proven',
    slug: 'learn/how-scoring-works',
  },
  {
    want: 'stand up a trust network for my community',
    slug: 'build/create-a-network',
  },
  {
    want: 'read scores from my app or contract',
    slug: 'build/integrate-scores',
  },
  { want: 'run everything locally, end to end', slug: 'build/quickstart' },
  { want: 'run the proving daemon', slug: 'build/run-a-prover' },
  { want: 'deploy to a real chain', slug: 'build/production' },
  {
    want: 'check the system’s claims for myself',
    slug: 'verify/reproduce-an-epoch',
  },
]
