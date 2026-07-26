'use client'

import { X } from 'lucide-react'
import { useState } from 'react'
import { Hex } from 'viem'
import { useAccount } from 'wagmi'

import { Button } from '@/components/Button'
import { Textarea } from '@/components/Textarea'

import { MAX_SEEDS, WizardData, parseAddressList, seedProblem } from '../model'
import { Field, Note, StepHeader } from '../ui'

export const SeedsStep = ({
  data,
  onChange,
  showErrors,
}: {
  data: WizardData
  onChange: (patch: Partial<WizardData>) => void
  showErrors: boolean
}) => {
  const { address } = useAccount()
  const [draft, setDraft] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  const add = (input: string) => {
    const { addresses, rejected } = parseAddressList(input)

    if (!addresses.length) {
      setProblem(
        rejected.length
          ? `That doesn't look like an Ethereum address: ${rejected[0]}`
          : 'Paste an Ethereum address to add it.'
      )
      return
    }

    const accepted: Hex[] = []
    let firstProblem: string | null = null
    for (const candidate of addresses) {
      const issue = seedProblem(candidate, [...data.seeds, ...accepted])
      if (issue) {
        firstProblem ||= issue
        continue
      }
      accepted.push(candidate)
    }

    if (accepted.length) {
      onChange({ seeds: [...data.seeds, ...accepted] })
      setDraft('')
    }

    setProblem(
      firstProblem ||
        (rejected.length
          ? `We skipped something that isn't an address: ${rejected[0]}`
          : null)
    )
  }

  const remove = (seed: Hex) =>
    onChange({ seeds: data.seeds.filter((existing) => existing !== seed) })

  const alreadyAdded =
    !!address &&
    data.seeds.some((seed) => seed.toLowerCase() === address.toLowerCase())

  const listError =
    showErrors && !data.seeds.length
      ? 'Add at least one account before you continue.'
      : null

  return (
    <div className="space-y-6">
      <StepHeader
        title="Who does your community already trust?"
        lead="Pick a few accounts everyone in your community already trusts. Scores flow outward from them: the people they vouch for score higher, then the people those people vouch for, and so on."
      />

      <Field
        label="Starting accounts"
        htmlFor="network-seeds"
        error={problem || listError}
        hint={`Paste one address per line, or several at once. Three to seven is a good start, and you can add up to ${MAX_SEEDS}.`}
      >
        <Textarea
          id="network-seeds"
          value={draft}
          rows={3}
          placeholder="0x1234...  (one address per line)"
          onChange={(e) => {
            setDraft(e.target.value)
            setProblem(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              add(draft)
            }
          }}
        />
      </Field>

      <div className="flex flex-row flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => add(draft)}
          disabled={!draft.trim()}
        >
          Add to list
        </Button>
        {address && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => add(address)}
            disabled={alreadyAdded}
          >
            {alreadyAdded ? 'Your account is on the list' : 'Add my account'}
          </Button>
        )}
      </div>

      {data.seeds.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">
            {data.seeds.length} of {MAX_SEEDS} added
          </div>
          <div className="flex flex-row flex-wrap gap-2">
            {data.seeds.map((seed) => (
              <span
                key={seed}
                className="inline-flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs"
              >
                <span className="font-mono">
                  {seed.slice(0, 8)}...{seed.slice(-6)}
                </span>
                <button
                  type="button"
                  onClick={() => remove(seed)}
                  aria-label={`Remove ${seed}`}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-3 pt-2">
        <Note>
          Choose accounts that are widely respected and careful about who they
          vouch for. Everything else in your network is built on top of them: an
          account that hands out vouches carelessly pulls whoever it vouches for
          up with it.
        </Note>
        <Note>
          Anyone your starting accounts cannot reach, directly or through a
          chain of vouches, scores zero. That is the intended behaviour, not a
          bug, but it does mean a brand new network looks empty until the first
          vouches land.
        </Note>
        {data.seeds.length === 1 && (
          <Note tone="warning">
            You have one starting account. If it goes quiet or loses its keys,
            nobody can be pulled into the network. Two or three is safer.
          </Note>
        )}
        <Note>
          Changing this list later means editing your network&apos;s settings by
          hand. This app has no screen for that yet, so pick carefully.
        </Note>
      </div>
    </div>
  )
}
