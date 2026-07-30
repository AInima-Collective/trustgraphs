'use client'

import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'

import { BrandMark, MARK_META } from '@/components/BrandMark'
import {
  MARK_IDS,
  TYPE_IDS,
  type TypeId,
  setMarkId,
  setTypeId,
  useMarkId,
  useTypeId,
} from '@/lib/labTheme'
import { cn } from '@/lib/utils'

/**
 * The comparison surface. Not a showcase — a decision tool.
 *
 * Two axes are live: which mark, and which display serif. Everything below the
 * controls is real UI (nav strip, table, form, buttons, a specimen of the
 * actual hero copy) so a choice is judged in context rather than against a
 * white square. Theme flips here too, because half the argument for any of
 * these marks is how they behave inverted.
 *
 * Deliberately not linked from the nav and marked noindex. It is scaffolding:
 * once the axes are settled, delete this route, prune the losing geometry from
 * BrandMark, and drop the unused families from layout.tsx.
 */

const TYPE_NOTES: Record<TypeId, string> = {
  instrument:
    'single weight · very high contrast · tight fit · the book-cover one',
  cormorant:
    'thinnest stems, most severe · fragile below 20px · furthest toward Urbanomic',
  garamond:
    'old-style humanist · small x-height · the printed-grimoire register',
  spectral: 'built for screens · lowest contrast · safest at paragraph length',
  newsreader:
    'a text face, not a display face · this is what commitments ships',
  mono: 'control group — no serif anywhere · what trustgraphs looked like before',
}

function Section({
  n,
  title,
  children,
}: {
  n: string
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="border-t border-border pt-6">
      <div className="mb-6 flex items-baseline gap-3">
        <span className="tg-marker">{n}</span>
        <h2 className="tg-label-strong">{title}</h2>
      </div>
      {children}
    </section>
  )
}

export function LabComponent() {
  const mark = useMarkId()
  const type = useTypeId()
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const isDark = resolvedTheme !== 'light'

  const families = ['graph', 'sigil', 'rank'] as const

  return (
    <div className="flex flex-col gap-12 pb-16">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="flex flex-col gap-4">
        <span className="tg-marker">trustgraphs · design lab</span>
        <h1 className="max-w-2xl">Pick a mark. Pick a voice.</h1>
        <p className="max-w-2xl text-text-muted">
          Both axes below are live and persist across reloads. Everything under
          them is real interface, so judge the choice against a table and a
          button rather than against a blank square. Flip the theme too — half
          the argument for any of these marks is how it behaves inverted.
        </p>
      </header>

      {/* ── Axis controls ──────────────────────────────────────────────── */}
      <div className="grid gap-px border border-border bg-border md:grid-cols-3">
        <div className="bg-surface p-4">
          <div className="tg-label mb-3">Theme</div>
          <div className="flex gap-2">
            {(['dark', 'light'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTheme(t)}
                className={cn(
                  'h-8 flex-1 border text-xs uppercase tracking-wider transition-colors',
                  mounted && (t === 'dark') === isDark
                    ? 'border-ink bg-ink text-ink-fg'
                    : 'border-border text-text-muted hover:border-hairline-strong hover:text-text'
                )}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="bg-surface p-4 md:col-span-2">
          <div className="tg-label mb-3">
            Display type — <span className="text-text">{type}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {TYPE_IDS.map((t) => (
              <button
                key={t}
                onClick={() => setTypeId(t)}
                className={cn(
                  'h-8 border px-3 text-xs uppercase tracking-wider transition-colors',
                  t === type
                    ? 'border-ink bg-ink text-ink-fg'
                    : 'border-border text-text-muted hover:border-hairline-strong hover:text-text'
                )}
              >
                {t}
              </button>
            ))}
          </div>
          <p className="mt-3 text-xs text-text-subtle">{TYPE_NOTES[type]}</p>
        </div>
      </div>

      {/* ── 01 · Mark sheet ────────────────────────────────────────────── */}
      <Section n="01" title="Marks">
        <div className="flex flex-col gap-8">
          {families.map((family) => (
            <div key={family}>
              <div className="tg-label mb-3">{family}</div>
              <div className="grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
                {MARK_IDS.filter((id) => MARK_META[id].family === family).map(
                  (id) => {
                    const selected = id === mark
                    return (
                      <button
                        key={id}
                        onClick={() => setMarkId(id)}
                        className={cn(
                          'flex items-center gap-4 bg-surface p-4 text-left transition-colors',
                          selected ? 'bg-surface-2' : 'hover:bg-surface-2'
                        )}
                      >
                        <BrandMark
                          mark={id}
                          size="xl"
                          className={selected ? 'text-text' : 'text-text-muted'}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span
                              className={cn(
                                'text-sm',
                                selected ? 'text-text' : 'text-text-muted'
                              )}
                            >
                              {id}
                            </span>
                            {selected && (
                              <span className="border border-ink px-1 text-[10px] uppercase tracking-wider text-text">
                                live
                              </span>
                            )}
                          </div>
                          <p className="mt-1 text-xs leading-relaxed text-text-subtle">
                            {MARK_META[id].note}
                          </p>
                          {/* The size ladder is the real test. If it dies at 12px
                           * it cannot be the nav mark, whatever it looks like at 96. */}
                          <div className="mt-3 flex items-end gap-3 text-text-muted">
                            <BrandMark mark={id} size="md" />
                            <BrandMark mark={id} size="sm" />
                            <BrandMark mark={id} size="xs" />
                          </div>
                        </div>
                      </button>
                    )
                  }
                )}
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* ── 02 · Lockup ────────────────────────────────────────────────── */}
      <Section n="02" title="Lockup">
        <div className="grid gap-px border border-border bg-border lg:grid-cols-2">
          <div className="flex flex-col gap-6 bg-surface p-6">
            <div className="tg-label">In the nav, at size</div>
            <div className="flex items-center gap-3">
              <BrandMark size="md" className="text-text" />
              <span className="text-lg">Trustgraphs</span>
            </div>
            <div className="flex items-center gap-2.5">
              <BrandMark size="sm" className="text-text" />
              <span className="text-sm">Trustgraphs</span>
            </div>
            <div className="flex items-center gap-2">
              <BrandMark size="xs" className="text-text" />
              <span className="text-xs">Trustgraphs</span>
            </div>
          </div>
          <div className="flex flex-col gap-6 bg-surface p-6">
            <div className="tg-label">Wordmark set in the display face</div>
            <div className="flex items-center gap-3">
              <BrandMark size="md" className="text-text" />
              <span className="tg-display text-2xl">Trustgraphs</span>
            </div>
            <div className="flex items-baseline gap-3">
              <span className="tg-display text-2xl">Trust</span>
              <BrandMark size="sm" className="text-text-muted" />
              <span className="tg-display text-2xl">graphs</span>
            </div>
          </div>
        </div>
      </Section>

      {/* ── 03 · Type specimen ─────────────────────────────────────────── */}
      <Section n="03" title="Voice">
        <div className="grid gap-px border border-border bg-border lg:grid-cols-2">
          <div className="flex flex-col gap-5 bg-surface p-6">
            <h1>Trust, made legible</h1>
            <h2>Every edge is signed and public</h2>
            <h3>Scores are recomputed, then proven</h3>
            <p className="text-text-muted">
              Body copy stays in PaperMono at every setting, because the numbers
              have to line up in a column and a proportional face will not do
              that. Only the display voice moves along this axis.
            </p>
            <p className="tg-serif-italic text-lg text-text-muted">
              An italic aside, set in whichever serif is currently mounted.
            </p>
          </div>
          <div className="flex flex-col gap-4 bg-surface p-6">
            <div className="tg-label">The hero, at full size</div>
            <p className="tg-display text-4xl leading-[1.05]">
              Belief, propagated until it settles
            </p>
            <div className="tg-rule my-2" />
            <div className="tg-label">At half</div>
            <p className="tg-display text-2xl">
              Belief, propagated until it settles
            </p>
          </div>
        </div>
      </Section>

      {/* ── 04 · Components ────────────────────────────────────────────── */}
      <Section n="04" title="In context">
        <div className="grid gap-px border border-border bg-border lg:grid-cols-2">
          {/* Table specimen — the densest surface in the app. */}
          <div className="bg-surface p-6">
            <div className="tg-label mb-4">Directory</div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="tg-label py-2 text-left font-normal">
                    Network
                  </th>
                  <th className="tg-label py-2 text-right font-normal">
                    Members
                  </th>
                  <th className="tg-label py-2 text-right font-normal">
                    Score
                  </th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['Demo Co-op', '14', '0.4471'],
                  ['Demo Co-op Contributions', '6', '0.2083'],
                ].map(([name, members, score]) => (
                  <tr
                    key={name}
                    className="border-b border-border last:border-0 hover:bg-surface-2"
                  >
                    <td className="py-2.5">{name}</td>
                    <td className="py-2.5 text-right tabular-nums text-text-muted">
                      {members}
                    </td>
                    <td className="py-2.5 text-right tabular-nums">{score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Controls specimen. */}
          <div className="flex flex-col gap-5 bg-surface p-6">
            <div className="tg-label">Controls</div>
            <div className="flex flex-wrap gap-2">
              <button className="h-9 border border-ink bg-ink px-4 text-xs uppercase tracking-wider text-ink-fg">
                Attest
              </button>
              <button className="h-9 border border-hairline-strong px-4 text-xs uppercase tracking-wider text-text hover:bg-surface-2">
                Cancel
              </button>
              <button className="h-9 border border-error px-4 text-xs uppercase tracking-wider text-error hover:bg-error-soft">
                Revoke
              </button>
            </div>
            <input
              className="h-9 w-full border border-hairline-strong bg-surface px-3 text-sm text-text placeholder:text-text-subtle focus:border-ink focus:outline-none"
              placeholder="0x0000…0000"
              readOnly
            />
            <div className="flex flex-wrap gap-2 text-xs uppercase tracking-wider">
              <span className="border border-success px-2 py-0.5 text-success">
                proven
              </span>
              <span className="border border-warn px-2 py-0.5 text-warn">
                pending
              </span>
              <span className="border border-error px-2 py-0.5 text-error">
                revoked
              </span>
              <span className="border border-border px-2 py-0.5 text-text-subtle">
                expired
              </span>
            </div>
            <div className="tg-rule" />
            <div className="flex items-baseline justify-between">
              <span className="tg-label">Root</span>
              <span className="text-sm tabular-nums">0x7f3a…c412</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="tg-label">Epoch</span>
              <span className="text-sm tabular-nums">154</span>
            </div>
          </div>
        </div>
      </Section>

      {/* ── 05 · Inversion ─────────────────────────────────────────────── */}
      <Section n="05" title="Inversion">
        <p className="mb-4 max-w-2xl text-sm text-text-muted">
          The mark has to survive both directions without a second file. These
          two panels force ink-on-paper and paper-on-ink side by side regardless
          of which theme is currently active.
        </p>
        <div className="grid gap-px border border-border bg-border sm:grid-cols-2">
          <div className="flex items-center justify-center gap-4 bg-[#0a0b0c] p-10 text-[#eceef0]">
            <BrandMark size="xl" />
            <span className="tg-display text-2xl">Trustgraphs</span>
          </div>
          <div className="flex items-center justify-center gap-4 bg-[#f7f8f8] p-10 text-[#0b0c0d]">
            <BrandMark size="xl" />
            <span className="tg-display text-2xl">Trustgraphs</span>
          </div>
        </div>
      </Section>

      <p className="text-xs text-text-subtle">
        Scaffolding. Once the axes are settled this route gets deleted, the
        losing geometry comes out of BrandMark, and layout.tsx drops the four
        unused font families.
      </p>
    </div>
  )
}
