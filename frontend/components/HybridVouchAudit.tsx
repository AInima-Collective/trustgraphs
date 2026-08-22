'use client'

import Link from 'next/link'

import type { AttestationData } from '@/lib/attestation'

import { SectionHeading } from './SectionHeading'

const short = (value: string, head = 10, tail = 8) =>
  value.length <= head + tail + 1
    ? value
    : `${value.slice(0, head)}…${value.slice(-tail)}`

/**
 * Accessible audit surface for every current edge in a hybrid graph.
 *
 * The canvas inspector is useful exploration, but it cannot be the only place provenance lives:
 * keyboard users and rollout reviewers need the exact signer/schema/UID/head/CID facts in the DOM.
 */
export function HybridVouchAudit({
  attestations,
}: {
  attestations: AttestationData[]
}) {
  return (
    <section aria-labelledby="hybrid-vouch-audit" className="space-y-4">
      <div className="space-y-1">
        <SectionHeading>
          <span id="hybrid-vouch-audit">Current vouch provenance</span>
        </SectionHeading>
        <p className="max-w-3xl text-xs leading-relaxed text-text-muted">
          These are the current cross-lane winners after deterministic
          replacement and revocation. Off-chain entries are public retained EAS
          v2 payloads anchored by Trustgraphs; canonical EAS off-chain
          revocation does not control them.
        </p>
      </div>

      {attestations.length === 0 ? (
        <div className="border border-border bg-surface p-4 text-xs text-text-muted">
          No current vouches. A revoke tombstone never reveals an older vouch
          from either lane.
        </div>
      ) : (
        <div className="overflow-x-auto border border-border bg-surface">
          <table className="w-full min-w-[58rem] border-collapse text-left text-xs">
            <thead className="border-b border-border text-[10px] uppercase tracking-wider text-text-subtle">
              <tr>
                <th className="p-3 font-normal">Source</th>
                <th className="p-3 font-normal">Signer → recipient</th>
                <th className="p-3 font-normal">Schema / UID / signed time</th>
                <th className="p-3 font-normal">Anchor and availability</th>
              </tr>
            </thead>
            <tbody>
              {attestations.map((attestation) => {
                const provenance = attestation.provenance
                const offchain =
                  provenance?.source === 'off-chain-eas' ? provenance : null
                const onchain =
                  provenance?.source === 'on-chain-eas' ? provenance : null
                return (
                  <tr
                    key={attestation.uid}
                    className="border-b border-hairline last:border-b-0 align-top"
                  >
                    <td className="p-3">
                      <span className="inline-flex border border-border px-2 py-1 text-[10px] uppercase tracking-wider text-text">
                        {offchain ? 'Off-chain EAS' : 'On-chain EAS'}
                      </span>
                    </td>
                    <td className="p-3 font-mono text-[10px] leading-relaxed">
                      <div title={attestation.attester}>
                        {short(attestation.attester)}
                      </div>
                      <div aria-hidden="true" className="text-text-subtle">
                        ↓
                      </div>
                      <div title={attestation.recipient}>
                        {short(attestation.recipient)}
                      </div>
                    </td>
                    <td className="space-y-1 p-3 font-mono text-[10px] leading-relaxed">
                      <div title={attestation.schema}>
                        Schema {short(attestation.schema)}
                      </div>
                      <div title={attestation.uid}>
                        UID {short(attestation.uid)}
                      </div>
                      <time
                        dateTime={new Date(
                          Number(attestation.time) * 1_000
                        ).toISOString()}
                      >
                        {attestation.formattedTime} UTC
                      </time>
                    </td>
                    <td className="space-y-1 p-3 font-mono text-[10px] leading-relaxed">
                      {offchain ? (
                        <>
                          <div title={offchain.head}>
                            Head {short(offchain.head)} · count {offchain.count}
                          </div>
                          <div title={offchain.cid}>CID {offchain.cid}</div>
                          <div title={offchain.anchorTransactionHash}>
                            Anchor tx {short(offchain.anchorTransactionHash)}
                          </div>
                          <div className="text-success">
                            Storage healthy · indexer independently verified
                            {offchain.fetchLatencyMs === null
                              ? ''
                              : ` in ${offchain.fetchLatencyMs} ms`}
                            {' · '}relay inclusion finalized
                          </div>
                          <div className="text-text-muted">
                            Revoke action: append a Trustgraphs in-log revoke
                          </div>
                        </>
                      ) : onchain?.transactionHash ? (
                        <Link
                          href={`/attestations/${attestation.uid}`}
                          className="underline underline-offset-2"
                        >
                          EAS transaction {short(onchain.transactionHash)}
                        </Link>
                      ) : (
                        <Link
                          href={`/attestations/${attestation.uid}`}
                          className="underline underline-offset-2"
                        >
                          Open EAS attestation
                        </Link>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
