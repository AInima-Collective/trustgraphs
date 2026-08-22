'use client'

import { Plus, Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { type Address, keccak256, stringToBytes, zeroAddress } from 'viem'
import { useAccount } from 'wagmi'

import { AccountIdentifierInput } from '@/components/AccountIdentifierInput'
import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { Input } from '@/components/Input'
import { Label } from '@/components/Label'
import { useAttestation } from '@/hooks/useAttestation'
import { useEnsResolver } from '@/hooks/useEns'
import { parseAccountIdentifier } from '@/lib/ens'
import { getAccountIdentifierErrorMessage } from '@/lib/ens-query'
import { ContributionsNetwork } from '@/lib/types'

import {
  BackToRound,
  ContributionsNav,
  useContributionsData,
} from '../contributions-shared'

type ContributorRow = {
  address: string
  share: string
  previewAddress?: Address | null
}

/**
 * Submit a contribution claim: what was done, a link to it, and who did it (with relative
 * shares). Listing only other people nominates them — they keep full control via Respond.
 */
export const ContributePage = ({
  network,
}: {
  network: ContributionsNetwork
}) => {
  const router = useRouter()
  const { address: connectedAddress, isConnected } = useAccount()
  const { round, claimSchema } = useContributionsData(network)
  const { createAttestation, isCreating } = useAttestation()
  const resolveAccountIdentifier = useEnsResolver()

  const [title, setTitle] = useState('')
  const [uri, setUri] = useState('')
  const [fingerprint, setFingerprint] = useState('')
  const [contributors, setContributors] = useState<ContributorRow[]>([
    { address: '', share: '100' },
  ])
  const [formError, setFormError] = useState<string | null>(null)
  const [isResolvingAccounts, setIsResolvingAccounts] = useState(false)

  // Prefill the first contributor row with the connected wallet (a self-claim by default).
  useEffect(() => {
    if (connectedAddress) {
      setContributors((rows) =>
        rows.length === 1 && rows[0].address === ''
          ? [{ address: connectedAddress, share: rows[0].share }]
          : rows
      )
    }
  }, [connectedAddress])

  const totalShares = contributors.reduce(
    (sum, row) => sum + (parseInt(row.share, 10) || 0),
    0
  )

  const includesSelf =
    !!connectedAddress &&
    contributors.some(
      (row) =>
        (row.previewAddress || row.address).toLowerCase() ===
        connectedAddress.toLowerCase()
    )
  const isNomination =
    !includesSelf &&
    contributors.some((row) => {
      const parsed = parseAccountIdentifier(row.address)
      return parsed.kind === 'address' || !!row.previewAddress
    })

  const windowClosed = useMemo(() => {
    if (!round) return false
    const now = BigInt(Math.floor(Date.now() / 1000))
    return now > BigInt(round.window.end) || now < BigInt(round.window.start)
  }, [round])

  const updateRow = (index: number, patch: Partial<ContributorRow>) =>
    setContributors((rows) =>
      rows.map((row, i) => (i === index ? { ...row, ...patch } : row))
    )

  const handleSubmit = async () => {
    setFormError(null)

    if (!claimSchema) {
      setFormError('This round is missing its contribution schema.')
      return
    }
    if (!title.trim()) {
      setFormError('Give the contribution a title.')
      return
    }
    const cleaned = contributors
      .map((row) => ({
        address: row.address.trim(),
        share: parseInt(row.share, 10),
        previewAddress: row.previewAddress,
      }))
      .filter((row) => row.address !== '')
    if (cleaned.length === 0) {
      setFormError('Name at least one contributor.')
      return
    }
    for (const row of cleaned) {
      const parsed = parseAccountIdentifier(row.address)
      if (parsed.kind !== 'address' && parsed.kind !== 'ens') {
        setFormError(
          `"${row.address}" is not a valid wallet address or ENS name.`
        )
        return
      }
      if (parsed.kind === 'ens' && !row.previewAddress) {
        setFormError(`Wait for ${parsed.name} to resolve before submitting.`)
        return
      }
      if (!Number.isInteger(row.share) || row.share < 0) {
        setFormError('Shares must be whole numbers (0 or more).')
        return
      }
    }
    if (!cleaned.some((row) => row.share > 0)) {
      setFormError('At least one contributor needs a share above zero.')
      return
    }

    const resolved: Array<{ address: Address; share: number }> = []
    setIsResolvingAccounts(true)
    try {
      for (const row of cleaned) {
        const account = await resolveAccountIdentifier(
          row.address,
          row.previewAddress
        )
        resolved.push({ address: account.address, share: row.share })
      }
    } catch (error) {
      setFormError(getAccountIdentifierErrorMessage(error))
      setIsResolvingAccounts(false)
      return
    }

    // The content fingerprint: a 32-byte hash as-is, anything else gets hashed for them,
    // empty = no fingerprint.
    const contentHash =
      fingerprint.trim() === ''
        ? `0x${'00'.repeat(32)}`
        : /^0x[0-9a-fA-F]{64}$/.test(fingerprint.trim())
          ? fingerprint.trim()
          : keccak256(stringToBytes(fingerprint.trim()))

    try {
      await createAttestation({
        schema: claimSchema.uid,
        recipient: zeroAddress,
        data: {
          title: title.trim(),
          contentHash,
          uri: uri.trim(),
          contributors: resolved.map((row) => row.address),
          shares: resolved.map((row) => row.share),
        },
      })
      router.push(`/networks/${network.id}`)
    } catch {
      // The attestation hook already surfaced the error via toast.
    } finally {
      setIsResolvingAccounts(false)
    }
  }

  return (
    <div className="space-y-8 max-w-3xl">
      <div className="space-y-4">
        <BackToRound network={network} />
        <h1 className="text-3xl font-bold">Claim a contribution</h1>
        <p className="text-muted-foreground">
          Describe work that deserves a share of this round&apos;s funding pool.
          The community rates it, and the pool splits by those ratings when the
          round settles.
        </p>
      </div>

      <ContributionsNav network={network} />

      {windowClosed && (
        <Card type="outline" size="lg" className="border-warn">
          <p className="text-sm text-warn">
            The round window is closed right now. You can still submit, but
            contributions outside the window won&apos;t be funded this round.
          </p>
        </Card>
      )}

      <Card type="accent" size="lg" className="space-y-6">
        <div className="space-y-2">
          <Label>What was done</Label>
          <Input
            placeholder="e.g. Organized the June community call"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label>Link to the work (optional)</Label>
          <Input
            placeholder="https://..."
            value={uri}
            onChange={(e) => setUri(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Anything raters can check: a repo, a document, photos, a recording.
          </p>
        </div>

        <div className="space-y-2">
          <Label>Content fingerprint (optional)</Label>
          <Input
            placeholder="Paste a file hash, or any text to fingerprint"
            value={fingerprint}
            onChange={(e) => setFingerprint(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            A permanent fingerprint of the work itself, so the record can prove
            what it pointed at even if the link changes. If you paste text that
            isn&apos;t already a hash, we store its hash.
          </p>
        </div>

        <div className="space-y-3">
          <Label>Who did the work</Label>
          <p className="text-xs text-muted-foreground">
            Shares are relative: someone with 200 gets twice the slice of
            someone with 100. They only split this contribution&apos;s payout,
            not the whole pool.
          </p>
          <div className="space-y-2">
            {contributors.map((row, index) => (
              <div key={index} className="flex flex-row gap-2 items-center">
                <AccountIdentifierInput
                  className="font-mono"
                  wrapperClassName="flex-1"
                  placeholder="0x… or name.eth"
                  value={row.address}
                  onResolvedAddressChange={(previewAddress) =>
                    updateRow(index, { previewAddress })
                  }
                  onChange={(e) =>
                    updateRow(index, {
                      address: e.target.value,
                      previewAddress: null,
                    })
                  }
                />
                <Input
                  className="w-24"
                  type="number"
                  min={0}
                  placeholder="Share"
                  value={row.share}
                  onChange={(e) => updateRow(index, { share: e.target.value })}
                />
                <span className="text-xs text-muted-foreground w-12 text-right">
                  {totalShares > 0 && parseInt(row.share, 10) > 0
                    ? `${Math.round((parseInt(row.share, 10) / totalShares) * 100)}%`
                    : '—'}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() =>
                    setContributors((rows) =>
                      rows.length > 1
                        ? rows.filter((_, i) => i !== index)
                        : rows
                    )
                  }
                  disabled={contributors.length === 1}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            ))}
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              setContributors((rows) => [
                ...rows,
                { address: '', share: '100' },
              ])
            }
          >
            <Plus className="w-4 h-4 mr-1" />
            Add contributor
          </Button>
        </div>

        {isNomination ? (
          <Card type="outline" size="md" className="space-y-1">
            <p className="text-sm font-medium">
              You&apos;re nominating other people.
            </p>
            <p className="text-sm text-muted-foreground">
              You&apos;re not on the contributor list yourself, so this claim
              gives credit (and money) only to the people you name. Each of them
              can accept or decline it on the Respond page. Until someone
              accepts, their share counts at half weight; if they decline, it is
              removed.
            </p>
          </Card>
        ) : (
          includesSelf && (
            <p className="text-xs text-muted-foreground">
              Your own share counts in full because you&apos;re the one
              submitting this claim. Anyone else you name should accept their
              share on the Respond page: until they do it counts at half weight,
              and if they decline it is removed.
            </p>
          )
        )}

        {formError && <p className="text-sm text-error">{formError}</p>}

        <Button
          variant="brand"
          onClick={handleSubmit}
          disabled={!isConnected || isCreating || isResolvingAccounts}
          className="w-full"
        >
          {!isConnected
            ? 'Connect your wallet to submit'
            : isCreating || isResolvingAccounts
              ? 'Submitting...'
              : 'Submit contribution'}
        </Button>
        <p className="text-xs text-muted-foreground">
          Submitting publishes this claim on-chain for everyone in the round to
          see and rate. You can revoke it later, but the history stays public.
        </p>
      </Card>
    </div>
  )
}
