'use client'

import { ArrowUpRight } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import toast from 'react-hot-toast'
import { Hex } from 'viem'
import { useAccount } from 'wagmi'

import { Address } from '@/components/Address'
import {
  AttestationStatusBadge,
  attestationComment,
  attestationConfidence,
  useSchemaToNetwork,
} from '@/components/AttestationTable'
import { BreadcrumbRenderer } from '@/components/BreadcrumbRenderer'
import { Button } from '@/components/Button'
import { CopyableText } from '@/components/CopyableText'
import { SectionHeading } from '@/components/SectionHeading'
import { useAttestation } from '@/hooks/useAttestation'
import { useEns } from '@/hooks/useEns'
import { usePushBreadcrumb } from '@/hooks/usePushBreadcrumb'
import { AttestationData, AttestationStatus } from '@/lib/attestation'
import { CHAIN } from '@/lib/config'
import { parseErrorMessage } from '@/lib/error'
import { formatBigNumber, formatTimeAgo, isHexEqual } from '@/lib/utils'

const ZERO_UID = `0x${'0'.repeat(64)}`

/** EAS runs its own explorer on these chains. */
const EAS_EXPLORERS: Partial<Record<string, string>> = {
  mainnet: 'https://easscan.org',
  sepolia: 'https://sepolia.easscan.org',
}

/** The fields the page already shows as the comment and the confidence. */
const SHOWN_FIELDS = new Set(['comment', 'confidence'])

const formatSeconds = (seconds: bigint) =>
  new Date(Number(seconds) * 1000).toISOString().replace('T', ' ').split('.')[0]

const shortAddress = (address: string) =>
  `${address.slice(0, 6)}…${address.slice(-4)}`

export const AttestationDetailPage = ({ uid }: { uid: Hex }) => {
  const {
    revokeAttestation,
    query: { data: attestation, isLoading, error },
    canRevoke,
    isRevoking,
  } = useAttestation(uid)

  const handleRevoke = async () => {
    if (!attestation) {
      return
    }

    try {
      await revokeAttestation(uid, attestation.schema as `0x${string}`)
    } catch (err) {
      console.error('Failed to revoke attestation:', err)
      toast.error(parseErrorMessage(err))
    }
  }

  return (
    <div className="space-y-10 sm:space-y-12">
      <BreadcrumbRenderer
        fallback={{
          title: 'Attestations',
          route: '/attestations',
        }}
      />

      {error ? (
        <div className="border border-error bg-error-soft p-4 rounded-sm">
          <div className="error-text text-sm text-error">
            ⚠️ {parseErrorMessage(error)}
          </div>
        </div>
      ) : isLoading ? (
        <div className="flex h-64 flex-col items-center justify-center border border-border text-center">
          <div className="text-sm text-text">◉ LOADING ATTESTATION ◉</div>
          <div className="text-xs mt-2 text-text-muted">
            Fetching the on-chain record...
          </div>
        </div>
      ) : !attestation ? (
        <div className="space-y-3 border border-border bg-surface py-10 text-center">
          <div className="text-sm text-text-muted">ATTESTATION NOT FOUND</div>
          <div className="px-4 font-mono text-xs break-all text-text-subtle">
            {uid}
          </div>
          <Link
            href="/attestations"
            className="tg-touch-target inline-flex items-center text-sm text-text-muted underline underline-offset-4 hover:text-text"
          >
            All attestations
          </Link>
        </div>
      ) : (
        <Attestation
          attestation={attestation}
          revoke={
            canRevoke ? (
              <Button
                variant="destructive"
                onClick={handleRevoke}
                disabled={isRevoking}
                className="h-11 px-5"
              >
                {isRevoking ? 'Revoking…' : 'Revoke'}
              </Button>
            ) : null
          }
        />
      )}
    </div>
  )
}

function Attestation({
  attestation,
  revoke,
}: {
  attestation: AttestationData
  /** The revoke action, for the attester. */
  revoke: ReactNode
}) {
  const pushBreadcrumb = usePushBreadcrumb()
  const network = useSchemaToNetwork()[attestation.schema.toLowerCase()]
  const comment = attestationComment(attestation)
  const otherFields = Object.entries(attestation.decodedData ?? {}).filter(
    ([name]) => !SHOWN_FIELDS.has(name)
  )
  const explorer = EAS_EXPLORERS[CHAIN]
  const expires = attestation.expirationTime > 0n

  return (
    <>
      <header className="flex w-full flex-col gap-5 lg:flex-row lg:items-start lg:justify-between lg:gap-10">
        <div className="flex min-w-0 flex-1 flex-col items-start gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <p className="tg-label">
              {network ? `Vouch in ${network.name}` : 'Attestation'}
            </p>
            <AttestationStatusBadge status={attestation.status} />
          </div>
          <h1 className="max-w-full break-words text-4xl font-bold">
            <PartyName address={attestation.attester} capitalize />{' '}
            <span className="text-text-muted">
              {network ? 'vouched for' : 'attested to'}
            </span>{' '}
            <PartyName address={attestation.recipient} />
          </h1>
          <p className="text-sm text-text-muted">
            {attestation.formattedTime} UTC · {attestation.formattedTimeAgo}
          </p>
        </div>

        {revoke && (
          <div className="flex shrink-0 flex-row flex-wrap items-center gap-3 lg:pt-1">
            {revoke}
          </div>
        )}
      </header>

      {comment && (
        <blockquote className="max-w-3xl border-l-2 border-hairline-strong pl-5 text-lg leading-relaxed whitespace-pre-line text-text">
          {comment}
        </blockquote>
      )}

      <section aria-label="Summary" className="space-y-4">
        <dl className="grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-4">
          <Fact label="Confidence">
            {formatBigNumber(
              attestationConfidence(attestation),
              undefined,
              true
            )}
          </Fact>
          <Fact label="Network">
            {network ? (
              <Link
                href={`/networks/${network.id}`}
                onClick={() => pushBreadcrumb()}
                className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
              >
                {network.name}
                <ArrowUpRight className="h-3 w-3 shrink-0" />
              </Link>
            ) : (
              <span className="text-text-muted">None</span>
            )}
          </Fact>
          <Fact label="Status">
            {attestation.status === AttestationStatus.REVOKED
              ? `Revoked ${formatTimeAgo(Number(attestation.revocationTime) * 1000)}`
              : attestation.status === AttestationStatus.EXPIRED
                ? `Expired ${formatTimeAgo(Number(attestation.expirationTime) * 1000)}`
                : 'Active'}
          </Fact>
          <Fact label="Expires">
            {expires ? formatSeconds(attestation.expirationTime) : 'Never'}
          </Fact>
        </dl>
      </section>

      <section aria-label="Accounts" className="grid gap-6 md:grid-cols-2">
        <Party label="Attester" address={attestation.attester} />
        <Party label="Recipient" address={attestation.recipient} />
      </section>

      <section aria-label="On-chain record" className="space-y-4">
        <SectionHeading
          actions={
            explorer && (
              <a
                href={`${explorer}/attestation/view/${attestation.uid}`}
                target="_blank"
                rel="noopener noreferrer"
                className="tg-touch-target inline-flex items-center gap-1 text-sm text-text-muted underline underline-offset-4 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              >
                View on EAS
                <ArrowUpRight className="h-3.5 w-3.5" />
              </a>
            )
          }
        >
          On-chain record
        </SectionHeading>
        <dl className="divide-y divide-border border-b border-border">
          <Row label="UID">
            <CopyableText text={attestation.uid} />
          </Row>
          <Row label="Schema">
            <CopyableText text={attestation.schema} />
          </Row>
          {attestation.ref !== ZERO_UID && (
            <Row label="Refers to">
              <Link
                href={`/attestations/${attestation.ref}`}
                onClick={() => pushBreadcrumb()}
                className="font-mono text-xs break-all underline underline-offset-4 hover:text-text"
              >
                {attestation.ref}
              </Link>
            </Row>
          )}
          <Row label="Revocable">{attestation.revocable ? 'Yes' : 'No'}</Row>
          {attestation.revocationTime > 0n && (
            <Row label="Revoked at">
              {formatSeconds(attestation.revocationTime)} UTC
            </Row>
          )}
          {otherFields.map(([name, value]) => (
            <Row key={name} label={name.replace(/_/g, ' ')}>
              <span className="font-mono text-xs break-all">
                {formatField(value)}
              </span>
            </Row>
          ))}
          {Object.keys(attestation.decodedData ?? {}).length === 0 && (
            <Row label="Data">
              <CopyableText text={attestation.data} truncate />
            </Row>
          )}
        </dl>
      </section>
    </>
  )
}

/** An attestation's party, named for the title: "You", the ENS name, or a short address. */
function PartyName({
  address,
  capitalize = false,
}: {
  address: Hex
  capitalize?: boolean
}) {
  const { address: connected } = useAccount()
  const { name } = useEns(address)
  const isYou = !!connected && isHexEqual(connected, address)
  return (
    <Link
      href={`/account/${address}`}
      className="underline-offset-8 decoration-2 hover:underline"
    >
      {isYou ? (capitalize ? 'You' : 'you') : name || shortAddress(address)}
    </Link>
  )
}

function Party({ label, address }: { label: string; address: Hex }) {
  return (
    <div className="flex flex-col items-start gap-2 border border-border bg-surface p-4">
      <p className="text-[10px] uppercase tracking-wider text-text-subtle">
        {label}
      </p>
      <Address
        address={address}
        displayMode="compact"
        showCopyIcon={false}
        showNavIcon
      />
      <CopyableText
        text={address}
        className="text-text-subtle"
        truncateOnMobile={false}
      />
    </div>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="bg-surface p-3">
      <dt className="text-[9px] uppercase tracking-wider text-text-subtle">
        {label}
      </dt>
      <dd className="mt-1 text-sm text-text">{children}</dd>
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-6">
      <dt className="text-[10px] uppercase tracking-wider text-text-subtle sm:pt-1">
        {label}
      </dt>
      <dd className="min-w-0 text-sm text-text">{children}</dd>
    </div>
  )
}

const formatField = (value: unknown): string =>
  value === undefined || value === null || value === ''
    ? '—'
    : Array.isArray(value)
      ? value.map(formatField).join(', ')
      : typeof value === 'object'
        ? JSON.stringify(value, (_, inner) =>
            typeof inner === 'bigint' ? inner.toString() : inner
          )
        : String(value)
