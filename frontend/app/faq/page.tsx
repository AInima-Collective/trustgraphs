import type { Metadata } from 'next'
import type { ReactNode } from 'react'

import { PageTitle, SectionHeading } from '@/components/SectionHeading'
import { socialCard } from '@/lib/metadata'

import { OpenTargetAnswer } from './OpenTargetAnswer'

/**
 * The questions page.
 *
 * The copy's source of record is `docs/learn/faq.md` (this page differs only in
 * typographic quotes). If a line needs to change, that file changes in the same
 * commit.
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
 * That last claim needed correcting, and the correction is `OpenTargetAnswer`.
 * The spec does define an ancestor-details-revealing algorithm, and this page
 * was built assuming it fires for an `id` on the `<summary>`. Measured, it does
 * not: the row is scrolled to and stays CLOSED in Chromium, Firefox and WebKit,
 * and a minimal hand-written control behaves identically, so it is the platform
 * rather than anything here. Every permalink is labelled "Link to this answer",
 * so every one of them was landing a reader on a question with the answer shut.
 * A five-line client island opens it, and with JavaScript off everything above
 * is still true: the fragment still scrolls to the right question and the
 * reader opens it with one click.
 */
const DESCRIPTION = 'What people ask before they trust a scoreboard.'

// Its own share card, for the same reason as /networks: inheriting the root
// layout's openGraph block gives every route one card titled "Trustgraphs".
//
// `twitter` is overridden alongside `openGraph`, not left to inherit. The root
// layout sets both, and overriding only one produced a page whose Slack unfurl
// and whose X card carried two different sentences for the same URL.
export const metadata: Metadata = {
  title: 'Questions',
  ...socialCard({
    title: 'Questions | trustgraphs',
    description: DESCRIPTION,
    path: '/faq',
  }),
}

const REPO = 'https://github.com/JakeHartnell/trustgraphs'
// The explainer and the spec are served by this app now (/docs renders the
// repo's docs/ tree), so these two stay on-site; only the code link leaves.
const ELI5 = '/docs/learn/what-is-trustgraphs'
const ALGORITHM = '/docs/concepts/algorithm'

/** Ink, underlined, and legible in prose at answer weight. No hue anywhere. */
const PROSE_LINK =
  'text-text underline underline-offset-2 transition-colors hover:text-text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink'

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
          'Your community does, when the network is created. They anchor the whole graph, so choosing them well is the real work. On a controller-backed network, Settings can draft and preview a later change, then routes the complete configuration through the controller’s actual owner — a wallet, Safe, or operational timelock. The next checkpoint activates it; settled rounds do not change.',
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
        question: 'Why don’t bot armies work?',
        // Rewritten twice. "Not one of those vouches moves any score" was
        // false: the node set is built from the edges, so vouching for each
        // other is how the island gets scored at all. And "accounts that
        // nobody vouched for" named the wrong set, since the bots are vouched
        // for, by each other. What matters is being unreachable from the seeds.
        // Measured at the old wizard default: 8 bots took 27% of the board and
        // 1000 took 53%. The default is now 100%; lowering it remains an
        // explicit, warned-about advanced choice. See issue #18.
        answer:
          'Score comes from trust flowing out of the starting accounts. A thousand bots vouching for each other form an island with lots of arrows and nothing flowing in, so none of those vouches earns any trust. The create form reserves the full starting share by default, which leaves a disconnected island at zero. A community can lower that advanced setting, but then every other account gets an equal slice of the remainder and a big enough island can hold a real share.',
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
          'Nothing. It isn’t there for privacy. It’s there so a whole scoreboard can be verified in one cheap on-chain check instead of everyone recomputing millions of scores.',
      },
      {
        id: 'how-do-you-know-a-prover-didnt-leave-someone-out',
        question: 'How do you know a prover didn’t leave someone out?',
        answer:
          'The chain keeps a running commitment to every attestation as it lands. A proof only verifies if it consumed exactly that set, so a prover can’t quietly drop the vouches they dislike or add ones that never happened.',
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
          // The appearance clause is cut, not softened: the indexer switches
          // factory discovery off whenever the deploy environment is production,
          // so on that chain a factory-created network is never indexed and
          // never listed. "A minute or two" promised a wait that ends.
          'Anyone. It takes one transaction and nobody approves it.',
      },
      {
        id: 'what-does-it-cost',
        question: 'What does it cost?',
        // Same correction as "Do I have to run a server?": a tank that has not
        // had its per-round limit set cannot pay anyone, and nothing in this
        // app sets it.
        answer:
          'Proving costs real money, so each network has a tank to pay whoever produces its scoreboard, once someone sets its per-round limit. Networks we curate will be proven at our expense. Pricing for everyone else is still being worked out.',
      },
      {
        id: 'do-i-have-to-run-a-server',
        question: 'Do I have to run a server?',
        // "A prover watches the chain" described a daemon nobody is running for
        // a stranger's network: the vault quotes every factory-made instance as
        // ineligible, so the operator holds rather than proving, and the only
        // other path is a hand-edited curated allowlist.
        answer:
          'Only if nobody else proves your rounds. Proving is permissionless, so anyone can freeze a round and land the result, and no operator can lock you out. Today that mostly means you or us: a tank cannot pay a bounty until someone sets its per-round limit with a direct contract call, and the networks we curate will be proven at our expense. If every machine we run vanished, anyone could recompute the scores of a network created through the app from what is on the chain, and prove them.',
      },
      {
        id: 'can-i-use-the-scores-somewhere-else',
        question: 'Can I use the scores somewhere else?',
        // The two halves did not compose: the download carries neither root nor
        // proof, and the chain holds a root rather than a board, so nothing can
        // be "read directly". A contract checks one pair at a time.
        answer:
          'Yes. A vouching network’s scoreboard downloads as CSV or JSON, and any contract can check one account’s score against the on-chain root, given the score and its proof.',
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
          'No. The proof loop is built and runs end to end on a test chain, though the on-chain proof check is still a stand-in and no real proof has been produced yet. The pieces around it are not finished. A network created through the app is governed by one wallet: the timelock that should hold those powers exists but is not wired up yet. More attestation sources are in progress.',
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
            <a href={ELI5} className={PROSE_LINK}>
              the plain-language explainer
            </a>
            , then{' '}
            <a href={ALGORITHM} className={PROSE_LINK}>
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
  // SVG STROKES, NOT `bg-current` BARS. Forced-colors mode remaps `color`,
  // `border-color` and SVG `stroke`, but flattens `background-color` to Canvas.
  // Drawn as two background-filled spans, the plus measured 1.00:1 against the
  // page in Windows High Contrast: a 24x24 crop centred on it was a single
  // colour. And the UA's own triangle is suppressed by `list-style: none` plus
  // the webkit marker rule, so all fifteen rows had no disclosure affordance at
  // all. The glyphs in `ProofDiagram` and `MoveFigures` already survive forced
  // colors for exactly this reason.
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 12 12"
      className="mt-[5px] block h-3 w-3 shrink-0 overflow-visible"
      fill="none"
    >
      <path d="M0 6 H12" stroke="currentColor" strokeWidth="1" />
      <path
        d="M6 0 V12"
        stroke="currentColor"
        strokeWidth="1"
        className="origin-center transition-transform group-open:scale-y-0"
      />
    </svg>
  )
}

function QuestionRow({ id, question, answer }: Question) {
  return (
    <details className="group border-b border-border">
      <summary
        id={id}
        className="flex cursor-pointer scroll-mt-6 list-none items-start justify-between gap-4 py-3 text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink [&::-webkit-details-marker]:hidden"
      >
        <span className="min-w-0">{question}</span>
        <OpenMarker />
      </summary>

      <div className="pb-5">
        <p className="text-text-muted">{answer}</p>
        <a
          href={`#${id}`}
          aria-label={`Link to this answer: ${question}`}
          // `justify-start`, not `justify-center`. The 44px box is a tap target
          // and it stays 44px, but centring a 7px glyph inside it hung the only
          // ink on the page 18px off the one edge everything else is aligned to:
          // question, answer and rule all start at the column's left margin and
          // the # floated in the whitespace under them, fifteen times.
          className="-mb-3 flex h-11 w-11 items-center justify-start text-xs text-text-subtle transition-colors hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
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
      {/* Renders nothing. The only client code on this page, and the page works
       * without it: see the module for what the platform does not do. */}
      <OpenTargetAnswer />
      <PageTitle>Questions</PageTitle>
      <p className="text-lg text-text-muted">
        What people ask before they trust a scoreboard.
      </p>

      {/* The Status group is the only place the caveats live now, so every
          group has to be one click away rather than a scroll away. */}
      <nav
        aria-label="Question groups"
        className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-1 border-y border-border"
      >
        {GROUPS.map((group) => (
          <a
            key={group.id}
            href={`#${group.id}`}
            className="inline-flex min-h-11 items-center tg-label text-text-muted transition-colors hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
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
          className="mt-20 scroll-mt-6 [@media(max-height:480px)]:mt-10"
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
