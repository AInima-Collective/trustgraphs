'use client'

import { X } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { Hex } from 'viem'
import { useAccount } from 'wagmi'

import { Button } from '@/components/Button'
import { Textarea } from '@/components/Textarea'
import { useEnsResolver } from '@/hooks/useEns'
import { getAccountIdentifierErrorMessage } from '@/lib/ens-query'

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
  const [adding, setAdding] = useState(false)
  const resolveAccountIdentifier = useEnsResolver()

  const add = async (input: string) => {
    if (adding) return
    const { addresses, names, rejected } = parseAddressList(input)

    if (!addresses.length && !names.length) {
      setProblem(
        rejected.length
          ? `That doesn't look like an Ethereum address or ENS name: ${rejected[0]}`
          : 'Paste an Ethereum address or ENS name to add it.'
      )
      return
    }

    setAdding(true)
    const accepted: Hex[] = []
    const acceptedNames: Record<string, string> = {}
    let firstProblem: string | null = null

    try {
      const capacity = Math.max(0, MAX_SEEDS - data.seeds.length)
      const addressCandidates = addresses.slice(0, capacity)
      const nameCandidates = names.slice(0, capacity)
      if (
        addresses.length > addressCandidates.length ||
        names.length > nameCandidates.length
      ) {
        firstProblem = `You can pick up to ${MAX_SEEDS} starting accounts.`
      }
      const candidates: Array<{ address: Hex; name?: string }> =
        addressCandidates.map((candidate) => ({ address: candidate }))

      // Bound forward-resolution fan-out to the same limit as presentation lookups.
      let nextName = 0
      const workers = Array.from(
        { length: Math.min(8, nameCandidates.length) },
        async () => {
          while (nextName < nameCandidates.length) {
            const name = nameCandidates[nextName++]
            try {
              const resolved = await resolveAccountIdentifier(name)
              candidates.push({ address: resolved.address, name })
            } catch (error) {
              firstProblem ||= getAccountIdentifierErrorMessage(error)
            }
          }
        }
      )
      await Promise.all(workers)

      for (const candidate of candidates) {
        const issue = seedProblem(candidate.address, [
          ...data.seeds,
          ...accepted,
        ])
        if (issue) {
          firstProblem ||= issue
          continue
        }
        accepted.push(candidate.address)
        if (candidate.name) {
          acceptedNames[candidate.address.toLowerCase()] = candidate.name
        }
      }

      if (accepted.length) {
        onChange({
          seeds: [...data.seeds, ...accepted],
          seedNames: { ...data.seedNames, ...acceptedNames },
        })
        setDraft('')
      }

      setProblem(
        firstProblem ||
          (rejected.length
            ? `We skipped something that isn't an address or ENS name: ${rejected[0]}`
            : null)
      )
    } finally {
      setAdding(false)
    }
  }

  const remove = (seed: Hex) => {
    const seedNames = { ...data.seedNames }
    delete seedNames[seed.toLowerCase()]
    onChange({
      seeds: data.seeds.filter((existing) => existing !== seed),
      seedNames,
    })
  }

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
        hint={`Paste one address or ENS name per line, or several at once. Start with three to five independent accounts; you can add up to ${MAX_SEEDS}.`}
      >
        <Textarea
          id="network-seeds"
          value={draft}
          rows={3}
          placeholder="0x1234… or name.eth (one per line)"
          onChange={(e) => {
            setDraft(e.target.value)
            setProblem(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void add(draft)
            }
          }}
        />
      </Field>

      <div className="flex flex-row flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void add(draft)}
          disabled={!draft.trim() || adding}
        >
          {adding ? 'Resolving…' : 'Add to list'}
        </Button>
        {address && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void add(address)}
            disabled={alreadyAdded || adding}
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
                  {data.seedNames[seed.toLowerCase()] ||
                    `${seed.slice(0, 8)}...${seed.slice(-6)}`}
                </span>
                {data.seedNames[seed.toLowerCase()] && (
                  <span className="font-mono text-muted-foreground">
                    {seed.slice(0, 8)}...{seed.slice(-6)}
                  </span>
                )}
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
          Want these accounts to count unequally?{' '}
          <Link
            href={
              data.seeds.length
                ? `/create/weighted?accounts=${data.seeds.join(',')}`
                : '/create/weighted'
            }
            className="underline underline-offset-4 hover:text-foreground"
          >
            Give each one its own starting share
          </Link>{' '}
          in the weighted workspace. The accounts you have added here go with
          you; that workspace creates its own kind of network.
        </Note>
        <Note>
          Anyone your starting accounts cannot reach, directly or through a
          chain of vouches, scores zero. That is the intended behaviour, not a
          bug, but it does mean a brand new network looks empty until the first
          vouches land.
        </Note>
        {data.seeds.length > 0 && data.seeds.length < 3 && (
          <Note tone="warning">
            Use at least three independent starting accounts for a real network.
            Their starting balance is split equally, so one account creates a
            large permanent floor even when nobody vouches for it. Three keeps
            each founder below the 15% default governance quorum in the measured
            40-member scenario; five lowers the floor further.
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
