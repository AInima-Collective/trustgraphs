import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (path: string) =>
  readFile(new URL(path, import.meta.url), 'utf8')

test('standard creation keeps gasless off-chain vouches disabled while retaining hybrid plumbing', async () => {
  const [model, addOns, review] = await Promise.all([
    source('../app/create/model.ts'),
    source('../app/create/steps/AddOnsStep.tsx'),
    source('../app/create/steps/ReviewStep.tsx'),
  ])
  assert.match(model, /withOffchainVouches: false/)
  assert.match(model, /MAX_OFFCHAIN_TOTAL_INPUTS = 200_000/)
  assert.match(model, /OFFCHAIN_INITIAL_RELAYERS/)
  assert.match(addOns, /Gasless off-chain vouches/)
  assert.match(addOns, /Coming soon/)
  assert.match(addOns, /enabled=\{false\} readOnly/)
  assert.doesNotMatch(addOns, /withOffchainVouches:/)
  assert.match(review, /createGovernedHybridInstance/)
  assert.match(review, /createGovernedInstance/)
  assert.match(review, /Gasless off-chain vouches are coming soon/)
})

test('standard creation presents scoring and governance decisions in their intended hierarchy', async () => {
  const [model, tuning, addOns, review] = await Promise.all([
    source('../app/create/model.ts'),
    source('../app/create/steps/TuningStep.tsx'),
    source('../app/create/steps/AddOnsStep.tsx'),
    source('../app/create/steps/ReviewStep.tsx'),
  ])

  assert.match(model, /DEFAULT_TUNING[\s\S]*cadence: 'fastest'/)
  const scoringAdvanced = tuning.indexOf('Advanced settings')
  assert.ok(
    tuning.indexOf('How often scores can be recalculated') < scoringAdvanced
  )
  assert.ok(tuning.indexOf('How much scores lean on vouches') < scoringAdvanced)
  assert.match(tuning, /Pay for score refreshes up front\?/)
  assert.match(tuning, /\/docs\/build\/run-a-prover/)
  assert.doesNotMatch(addOns, /Pay for score refreshes up front\?/)

  const extrasAdvanced = addOns.indexOf('Advanced settings')
  assert.ok(
    addOns.indexOf('Member governance is included') <
      addOns.indexOf('Add a shared fund')
  )
  assert.ok(
    addOns.indexOf('Keep Safe signers aligned with scores') > extrasAdvanced
  )

  for (const section of [
    'Network',
    'Scoring and publication',
    'Governance and extras',
    'Edit extras',
  ]) {
    assert.ok(review.includes(section), `missing review section: ${section}`)
  }
})

test('vouch surface reviews both typed messages and gates success on final indexed verification', async () => {
  const [modal, hook] = await Promise.all([
    source('../components/CreateAttestationModal.tsx'),
    source('../hooks/useEasOffchainVouches.ts'),
  ])
  assert.match(modal, /Review the exact EAS v2 typed message/)
  assert.match(modal, /Review the exact append-head typed message/)
  assert.match(modal, /Export recoverable signed bundle/)
  assert.match(modal, /Mixed-lane history and current winner/)
  assert.match(modal, /handleStrictRevoke/)
  assert.match(hook, /prepareAttest/)
  assert.match(hook, /prepareRevoke/)
  assert.match(hook, /validateSignedBundle\(signed\)/)
  assert.match(hook, /finalizedIndexerVerified: true/)
  assert.match(hook, /action === 'reload'/)
  assert.match(hook, /PROJECTED_WORK/)
})

test('wallet chooser commits open before optional connector discovery', async () => {
  const wallet = await source('../components/WalletConnectionButton.tsx')
  const open = wallet.indexOf('onClick()')
  const deferredDiscovery = wallet.indexOf('setTimeout(() => {', open)
  assert.ok(open >= 0, 'wallet trigger does not open its popup')
  assert.ok(
    deferredDiscovery > open,
    'connector discovery can swallow the popup open transition'
  )
})

test('permissionless network detail renders instances created after the production build', async () => {
  const page = await source('../app/networks/[id]/page.tsx')
  assert.match(page, /export const dynamic = 'force-dynamic'/)
  assert.doesNotMatch(page, /generateStaticParams/)
  assert.match(page, /await getNetwork\(id\)/)
})

test('permissionless network settings renders instances created after the production build', async () => {
  const page = await source('../app/networks/[id]/settings/page.tsx')
  assert.match(page, /export const dynamic = 'force-dynamic'/)
  assert.doesNotMatch(page, /generateStaticParams/)
  assert.doesNotMatch(page, /export const revalidate/)
  assert.match(page, /await searchParams/)
  assert.match(page, /await getNetwork\(id\)/)
})

test('browser recompute independently checks exact CIDs, signatures, prefixes and commit time', async () => {
  const [audit, context] = await Promise.all([
    source('./eas-offchain.ts'),
    source('../contexts/NetworkContext.tsx'),
  ])
  assert.match(audit, /payloadCommitment\(bytes\)/)
  assert.match(audit, /validateSignedBundle/)
  assert.match(audit, /recoverHeadSigner/)
  assert.match(audit, /prefixHeads\(payload\)/)
  assert.match(audit, /body\.time > BigInt\(firstAnchor\.blockTimestamp\)/)
  assert.match(context, /strictAudit\?\.edges \?\? \[\]/)
  assert.match(context, /provenance\?\.source !== 'off-chain-eas'/)
  assert.match(
    context,
    /exact-parameter browser root matches the published root/
  )
  assert.match(context, /Reduced display:/)
})

test('hybrid-incompatible contribution actions are blocked while on-chain EAS remains intact', async () => {
  const [round, settings, onchain, modal] = await Promise.all([
    source('../app/networks/[id]/contributions/new/component.tsx'),
    source('../app/networks/[id]/settings/component.tsx'),
    source('../hooks/useAttestation.ts'),
    source('../components/CreateAttestationModal.tsx'),
  ])
  assert.match(
    round,
    /Contribution rounds are unavailable for this hybrid network/
  )
  assert.match(settings, /Contribution rounds are blocked for hybrid networks/)
  assert.match(settings, /signer-sync does not[\s\S]*strict off-chain history/)
  assert.match(onchain, /functionName: 'attest'/)
  assert.match(onchain, /functionName: 'revoke'/)
  assert.match(modal, /await createAttestation/)
  assert.match(modal, /await revokeAttestation/)
})

test('normal graph exposes source, current head, CID, storage health and in-log revoke boundary', async () => {
  const [graph, audit, networkPage, settings] = await Promise.all([
    source('../components/NetworkGraph.tsx'),
    source('../components/HybridVouchAudit.tsx'),
    source('../app/networks/[id]/component.tsx'),
    source('../app/networks/[id]/settings/component.tsx'),
  ])
  assert.match(graph, /Off-chain EAS · independently verified retained CID/)
  assert.match(graph, /Current head/)
  assert.match(graph, /Current anchor tx/)
  assert.match(
    graph,
    /Relay inclusion: finalized · storage\/indexer health: verified/
  )
  assert.match(graph, /revocation is Trustgraphs in-log only/)
  assert.match(audit, /Current vouch provenance/)
  assert.match(audit, /Storage healthy · indexer independently verified/)
  assert.match(audit, /relay inclusion finalized/)
  assert.match(audit, /append a Trustgraphs in-log revoke/)
  assert.match(networkPage, /HybridVouchAudit/)
  assert.match(settings, /functionName: 'workCount'/)
  assert.match(settings, /Combined proof work/)
})
