import type { Metadata } from 'next'
import type { ReactNode } from 'react'

import { PageTitle, SectionHeading } from '@/components/SectionHeading'

/**
 * The questions page.
 *
 * Every sentence here is verbatim from `FAQ_PAGE_COPY.md`. If a line needs to
 * change, that file changes in the same commit.
 *
 * ── Why <details> and not an accordion component ────────────────────────────
 * The old landing page carried a four-item accordion built on `useState`. That
 * version could not be found by the browser's own in-page search, did not
 * print, did nothing without JavaScript, and had to re-implement keyboard
 * behaviour the platform already ships. `<details>`/`<summary>` is native
 * disclosure: it is keyboard-complete for free, it prints open when open, the
 * whole page is server-rendered HTML with no client bundle, and a browser that
 * navigates to a question's fragment opens it on arrival.
 *
 * That last part is why the stable `id` sits on the `<summary>` rather than on
 * the `<details>`: the HTML spec's ancestor-details-revealing algorithm walks
 * the *ancestors* of the fragment target, so an id on the summary opens the
 * disclosure around it, while an id on the details itself would only scroll to
 * a still-closed row.
 */
export const metadata: Metadata = {
  title: 'Questions',
  description: 'What people ask before they trust a scoreboard.',
}

const REPO = 'https://github.com/JakeHartnell/ZkTrustGraph'
const ELI5 = `${REPO}/blob/main/docs/ELI5.md`
const ALGORITHM = `${REPO}/blob/main/docs/ALGORITHM.md`

/** Ink, underlined, and legible in prose at answer weight. No hue anywhere. */
const PROSE_LINK =
  'text-text underline underline-offset-2 transition-colors hover:text-text-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

type Question = {
  /** Slug of the question. Stable: answers are linked by it from outside. */
  id: string
  question: string
  answer: ReactNode
}

type Group = {
  id: string
  name: string
  questions: Question[]
}

const GROUPS: Group[] = [
  {
    id: 'basics',
    name: 'Basics',
    questions: [
      {
        id: 'what-is-an-attestation',
        question: 'What is an attestation?',
        answer:
          'A signed public statement about someone, recorded on-chain through the Ethereum Attestation Service. A vouch is one kind. You can revoke it later.',
      },
      {
        id: 'who-picks-the-starting-accounts',
        question: 'Who picks the starting accounts?',
        answer:
          'Your community does, when the network is created. They anchor the whole graph, so choosing them well is the real work. Everything downstream is math.',
      },
      {
        id: 'how-often-do-scores-update',
        question: 'How often do scores update?',
        answer:
          'In rounds. Each round freezes the set of vouches at a cut-off, someone proves the new scores, and the result goes on-chain. Every network sets its own pace, and a settled round is never recalculated.',
      },
    ],
  },
  {
    id: 'trust-and-gaming',
    name: 'Trust and gaming',
    questions: [
      {
        id: 'can-someone-buy-a-high-score',
        question: 'Can someone buy a high score?',
        answer:
          'Not with money. Buying score means getting genuinely trusted people to vouch for you. What no algorithm stops is a trusted person vouching badly, which is a problem every community already has.',
      },
      {
        id: 'why-dont-bot-armies-work',
        question: "Why don't bot armies work?",
        answer:
          'Score comes from trust flowing out of the starting accounts. A thousand bots vouching for each other form an island with lots of arrows and nothing flowing in, so not one of those vouches moves any score. Reserve the whole head start for your starting accounts when you create a network, or accounts that nobody vouched for still hold a share of the scoreboard.',
      },
      {
        id: 'is-my-data-private',
        question: 'Is my data private?',
        answer:
          'No. Vouches, rules, code, and scores are all public. That is what makes the scoreboard checkable by anyone.',
      },
      {
        id: 'then-what-does-the-zero-knowledge-proof-hide',
        question: 'Then what does the zero-knowledge proof hide?',
        answer:
          "Nothing. It isn't there for privacy. It's there so a whole scoreboard can be verified in one cheap on-chain check instead of everyone recomputing millions of scores.",
      },
      {
        id: 'how-do-you-know-a-prover-didnt-leave-someone-out',
        question: "How do you know a prover didn't leave someone out?",
        answer:
          "The chain keeps a running commitment to every attestation as it lands. A proof only verifies if it consumed exactly that set, so a prover can't quietly drop the vouches they dislike or add ones that never happened.",
      },
    ],
  },
  {
    id: 'running-a-network',
    name: 'Running a network',
    questions: [
      {
        id: 'who-can-create-one',
        question: 'Who can create one?',
        answer:
          'Anyone. It takes one transaction and nobody approves it. It appears in the app once the indexer has caught up with the chain, which takes a minute or two.',
      },
      {
        id: 'what-does-it-cost',
        question: 'What does it cost?',
        answer:
          'Proving costs real money, so each network funds a tank that pays whoever produces its scoreboard. Networks we curate will be proven at our expense. Pricing for everyone else is still being worked out.',
      },
      {
        id: 'do-i-have-to-run-a-server',
        question: 'Do I have to run a server?',
        answer:
          "No. Proving is permissionless: a prover watches the chain, freezes each round on your network's schedule, and lands the result, and your network's tank pays whoever does it. If every machine we run vanished, anyone could recompute the scores from public data and prove them.",
      },
      {
        id: 'can-i-use-the-scores-somewhere-else',
        question: 'Can I use the scores somewhere else?',
        answer:
          'Yes. The published scoreboard downloads as CSV or JSON, and any contract can read the on-chain scoreboard directly.',
      },
    ],
  },
  {
    id: 'status',
    name: 'Status',
    questions: [
      {
        id: 'is-this-ready-for-production',
        question: 'Is this ready for production?',
        answer:
          'No. The proof loop is built and runs end to end on a test chain, and the pieces around it are not finished. A network created through the app is governed by one wallet: the timelock that should hold those powers exists but is not wired up yet. More attestation sources are in progress.',
      },
      {
        id: 'has-it-been-audited',
        question: 'Has it been audited?',
        answer:
          'Not by an outside firm. Point a network at something you can afford to get wrong.',
      },
      {
        id: 'where-do-i-read-the-details',
        question: 'Where do I read the details?',
        answer: (
          <>
            <a
              href={REPO}
              target="_blank"
              rel="noopener noreferrer"
              className={PROSE_LINK}
            >
              The code and the design docs
            </a>{' '}
            are open. Start with{' '}
            <a
              href={ELI5}
              target="_blank"
              rel="noopener noreferrer"
              className={PROSE_LINK}
            >
              the plain-language explainer
            </a>
            , then{' '}
            <a
              href={ALGORITHM}
              target="_blank"
              rel="noopener noreferrer"
              className={PROSE_LINK}
            >
              the algorithm spec
            </a>
            .
          </>
        ),
      },
    ],
  },
]

/**
 * A plus that becomes a minus. Two hairlines in `currentColor`, so the state is
 * carried by shape rather than by colour and it reads the same in both themes.
 * The collapse is a transform, which `prefers-reduced-motion` already flattens
 * globally in globals.css.
 */
function OpenMarker() {
  return (
    <span
      aria-hidden="true"
      className="relative mt-[5px] block h-3 w-3 shrink-0"
    >
      <span className="absolute top-1/2 left-0 block h-px w-3 -translate-y-1/2 bg-current" />
      <span className="absolute top-0 left-1/2 block h-3 w-px -translate-x-1/2 bg-current transition-transform group-open:scale-y-0" />
    </span>
  )
}

function QuestionRow({ id, question, answer }: Question) {
  return (
    <details className="group border-b border-border">
      <summary
        id={id}
        className="flex cursor-pointer scroll-mt-6 list-none items-start justify-between gap-4 py-3 text-text focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden"
      >
        <span className="min-w-0">{question}</span>
        <OpenMarker />
      </summary>

      <div className="pb-5">
        <p className="text-text-muted">{answer}</p>
        <a
          href={`#${id}`}
          aria-label={`Link to this answer: ${question}`}
          className="-mb-3 flex h-11 w-11 items-center justify-center text-xs text-text-subtle transition-colors hover:text-text focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
        >
          <span aria-hidden="true">#</span>
        </a>
      </div>
    </details>
  )
}

export default function FaqPage() {
  return (
    <div className="w-full max-w-[72ch]">
      <PageTitle>Questions</PageTitle>
      <p className="text-lg text-text-muted">
        What people ask before they trust a scoreboard.
      </p>

      {/* The Status group is the only place the caveats live now, so every
          group has to be one click away rather than a scroll away. */}
      <nav
        aria-label="Question groups"
        className="mt-6 flex flex-wrap items-center gap-x-5 border-y border-border"
      >
        {GROUPS.map((group) => (
          <a
            key={group.id}
            href={`#${group.id}`}
            className="inline-flex min-h-11 items-center font-mono text-xs tracking-[var(--tracking-wide)] text-text-muted uppercase transition-colors hover:text-text focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
          >
            {group.name}
          </a>
        ))}
      </nav>

      {GROUPS.map((group) => (
        <section
          key={group.id}
          id={group.id}
          aria-label={group.name}
          className="mt-10 scroll-mt-6"
        >
          <SectionHeading>{group.name}</SectionHeading>
          {group.questions.map((question) => (
            <QuestionRow key={question.id} {...question} />
          ))}
        </section>
      ))}
    </div>
  )
}
