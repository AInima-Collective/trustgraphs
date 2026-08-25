/**
 * Public documentation routes in reading order.
 *
 * Markdown under `docs/` is the source of record. Slugs mirror source paths:
 * `/docs/learn/faq` renders `docs/learn/faq.md`. Material under `research/`
 * remains available in the repository but is not published on the docs site.
 */

export type DocItem = {
  slug: string
  label: string
}

export type DocGroup = {
  label?: string
  collapsible?: boolean
  items: DocItem[]
}

export type DocSection = {
  dir: string
  label: string
  blurb: string
  groups: DocGroup[]
}

export { REPO_URL } from '../repository'

export const DOCS_SECTIONS: DocSection[] = [
  {
    dir: 'learn',
    label: 'Learn',
    blurb:
      'The Trustgraphs model, the standard vouching use case, proofs, and governance.',
    groups: [
      {
        items: [
          { slug: 'learn/what-is-trustgraphs', label: 'What is trustgraphs?' },
          { slug: 'learn/how-scoring-works', label: 'How vouch scoring works' },
          { slug: 'learn/proofs', label: 'Why trust the result' },
          { slug: 'learn/governance', label: 'Governance' },
          { slug: 'learn/faq', label: 'Questions' },
        ],
      },
    ],
  },
  {
    dir: 'concepts',
    label: 'Concepts',
    blurb:
      'The shared proof architecture, network model, and standard vouching mechanics.',
    groups: [
      {
        items: [
          { slug: 'concepts/architecture', label: 'Architecture' },
          {
            slug: 'concepts/networks-and-programs',
            label: 'Networks and programs',
          },
          { slug: 'concepts/epochs-and-proofs', label: 'Epochs and proofs' },
          { slug: 'concepts/algorithm', label: 'Vouch scoring algorithm' },
        ],
      },
    ],
  },
  {
    dir: 'build',
    label: 'Build',
    blurb:
      'Create a network, integrate its scores, or operate trustgraphs infrastructure.',
    groups: [
      {
        label: 'Get started',
        items: [
          { slug: 'build/create-a-network', label: 'Create a network' },
          { slug: 'build/integrate-scores', label: 'Integrate outputs' },
          { slug: 'build/setup', label: 'Set up the repository' },
          { slug: 'build/quickstart', label: 'Run locally' },
        ],
      },
      {
        label: 'Operate',
        items: [
          { slug: 'build/run-a-prover', label: 'Run a prover' },
          { slug: 'build/run-an-agent', label: 'Run an agent' },
          { slug: 'build/railway', label: 'Deploy the Sepolia testnet' },
          { slug: 'build/production', label: 'Deploy to a public chain' },
          { slug: 'build/add-a-program', label: 'Add a program' },
        ],
      },
      {
        label: 'Programs and extensions',
        items: [
          { slug: 'build/trust-graph', label: 'Trust graph' },
          { slug: 'build/weighted-prior', label: 'Weighted prior' },
          { slug: 'build/signer-sync', label: 'Signer sync' },
          { slug: 'build/hypercerts', label: 'Hypercerts' },
          { slug: 'build/nostr-workspace', label: 'Nostr workspace' },
          { slug: 'build/contributions', label: 'Contributions' },
          {
            slug: 'build/offchain-attestations',
            label: 'Off-chain attestations',
          },
          { slug: 'build/composition', label: 'Score compositions' },
        ],
      },
    ],
  },
  {
    dir: 'verify',
    label: 'Verify',
    blurb:
      'Reproduce public EAS results and check program builds, encodings, and deployments.',
    groups: [
      {
        items: [
          {
            slug: 'verify/reproduce-an-epoch',
            label: 'Reproduce a public EAS epoch',
          },
          { slug: 'verify/golden-vectors', label: 'Golden vectors' },
          { slug: 'verify/addresses-and-vkeys', label: 'Addresses and vkeys' },
        ],
      },
    ],
  },
]

export const DOCS_ORDER: DocItem[] = DOCS_SECTIONS.flatMap((section) =>
  section.groups.flatMap((group) => group.items)
)

const BY_SLUG = new Map(DOCS_ORDER.map((item) => [item.slug, item]))

export const getDocItem = (slug: string): DocItem | undefined =>
  BY_SLUG.get(slug)

export const getSection = (dir: string): DocSection | undefined =>
  DOCS_SECTIONS.find((section) => section.dir === dir)

export const DOCS_TASKS: { want: string; slug: string }[] = [
  {
    want: 'understand what trustgraphs does',
    slug: 'learn/what-is-trustgraphs',
  },
  {
    want: 'learn how EAS vouches become proven scores',
    slug: 'learn/how-scoring-works',
  },
  {
    want: 'create a Trustgraphs network',
    slug: 'build/create-a-network',
  },
  {
    want: 'seed a network with a weighted prior',
    slug: 'build/weighted-prior',
  },
  {
    want: 'combine several proven score sets',
    slug: 'build/composition',
  },
  {
    want: 'use a proven output in my app or contract',
    slug: 'build/integrate-scores',
  },
  { want: 'run the stack locally', slug: 'build/quickstart' },
  { want: 'run the proving daemon', slug: 'build/run-a-prover' },
  {
    want: 'delegate network upkeep or voting',
    slug: 'build/run-an-agent',
  },
  { want: 'deploy to a production chain', slug: 'build/production' },
  {
    want: 'verify a published result',
    slug: 'verify/reproduce-an-epoch',
  },
]
