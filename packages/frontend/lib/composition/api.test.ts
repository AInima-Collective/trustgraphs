import assert from 'node:assert/strict'

import {
  SCORE_OUTPUT_DOMAIN_IDS,
  SCORE_PROGRAM_IDS,
  type ScoreProgramProvenance,
} from '../score-program'
import {
  CompositionApiUnavailableError,
  type CompositionCandidate,
  classifySourceEligibility,
  fetchCompositionBundle,
  fetchCompositionCandidates,
  fetchCompositionSource,
  requireCompatibleCandidate,
} from './api'
import { compositionGoldenFixture } from './fixture'

const originalFetch = globalThis.fetch
const sourceFixture = compositionGoldenFixture().sources[0]!
const acceptedAtBlock = sourceFixture.freezeBlock + 17n
const program: ScoreProgramProvenance = {
  programId: SCORE_PROGRAM_IDS['trust-graph'],
  programName: 'trust-graph',
  outputDomain: SCORE_OUTPUT_DOMAIN_IDS['trust-graph-account-v1'],
  outputDomainName: 'trust-graph-account-v1',
  keyEncoding: 'eip155-address',
  instanceId: sourceFixture.instanceId,
  verifier: sourceFixture.verifier,
  registryOrAccumulator: '0x8181818181818181818181818181818181818181',
  paramsHash: sourceFixture.paramsHash,
  source: {
    kind: 'instance-registered',
    registry: sourceFixture.registry,
    blockNumber: '100',
    logIndex: 1,
    transactionHash:
      '0x8282828282828282828282828282828282828282828282828282828282828282',
  },
}
const candidate: CompositionCandidate = {
  instanceId: sourceFixture.instanceId,
  name: 'Source A',
  chainId: '10',
  snapshot: sourceFixture.snapshot,
  controller: sourceFixture.controller,
  programId: program.programId,
  programName: program.programName,
  outputDomain: program.outputDomain,
  keyEncoding: program.keyEncoding,
  registry: sourceFixture.registry,
  verifier: sourceFixture.verifier,
  paramsHash: sourceFixture.paramsHash,
  createdTimestamp: '100',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const main = async () => {
  try {
    globalThis.fetch = (async (input) => {
      const url = String(input)
      if (url === 'https://api.test/instances?limit=200&offset=0') {
        return json({
          instances: [
            {
              id: candidate.instanceId,
              name: candidate.name,
              chainId: candidate.chainId,
              createdTimestamp: candidate.createdTimestamp,
              paramsHash: candidate.paramsHash,
              contracts: {
                merkleSnapshot: candidate.snapshot,
                trustgraphsParamsController: candidate.controller,
              },
              scoreProgram: program,
            },
            {
              id: `0x${'91'.repeat(32)}`,
              name: 'Nostr workspace',
              chainId: candidate.chainId,
              createdTimestamp: '101',
              paramsHash: `0x${'92'.repeat(32)}`,
              contracts: {
                merkleSnapshot: `0x${'93'.repeat(20)}`,
                trustgraphsParamsController: null,
              },
              scoreProgram: {
                ...program,
                programId: SCORE_PROGRAM_IDS['nostr-workspace'],
                programName: 'nostr-workspace',
                outputDomain: SCORE_OUTPUT_DOMAIN_IDS['nostr-member-v1'],
                outputDomainName: 'nostr-member-v1',
                keyEncoding: 'bytes32',
                instanceId: `0x${'91'.repeat(32)}`,
                paramsHash: `0x${'92'.repeat(32)}`,
              },
            },
          ],
          pagination: { total: 2 },
        })
      }
      if (url === 'https://api.test/weighted-priors?limit=200&offset=0') {
        return json({
          instances: [
            {
              id: `0x${'a1'.repeat(32)}`,
              name: 'Weighted source',
              chainId: candidate.chainId,
              snapshot: `0x${'a2'.repeat(20)}`,
              controller: `0x${'a3'.repeat(20)}`,
              currentParamsHash: `0x${'a4'.repeat(32)}`,
              createdTimestamp: '102',
            },
          ],
          page: { total: 1 },
        })
      }
      if (url === `https://api.test/merkle/${candidate.snapshot}/current`) {
        return json({
          tree: {
            root: sourceFixture.outputRoot,
            ipfsHash: sourceFixture.blobSha256,
            ipfsHashCid: sourceFixture.cid,
            numAccounts: sourceFixture.entries.length,
            totalValue: sourceFixture.totalValue.toString(),
            blockNumber: acceptedAtBlock.toString(),
            timestamp: '999999',
          },
          entries: sourceFixture.entries.map((entry) => ({
            account: entry.account,
            value: entry.value.toString(),
            proof: [],
          })),
          scoreProgram: program,
        })
      }
      if (url.endsWith('/epochs/7/bundle')) {
        return json({ provenance: { cryptographic: {}, governance: {} } })
      }
      return json({ error: `unexpected ${url}` }, 500)
    }) as typeof fetch

    const catalog = await fetchCompositionCandidates('https://api.test')
    assert.equal(catalog.candidates.length, 2)
    assert.ok(
      catalog.candidates.some((row) => row.snapshot === candidate.snapshot)
    )
    assert.ok(
      catalog.candidates.some(
        (row) => row.programName === 'trust-graph-weighted'
      ),
      'weighted-score Trustgraphs remain selectable composition sources'
    )
    assert.equal(
      catalog.candidates.some((row) => row.programName === 'nostr-workspace'),
      false,
      'bytes32 Nostr scores cannot be relabeled as address-keyed trust-compose inputs'
    )
    assert.deepEqual(catalog.warnings, [])

    const source = await fetchCompositionSource({
      api: 'https://api.test',
      candidate,
      chain: {
        provenanceEnabled: true,
        stateIndex: sourceFixture.stateIndex,
        checkpointId: sourceFixture.checkpointId,
        acceptedAtBlock,
        freezeBlock: sourceFixture.freezeBlock,
        outputRoot: sourceFixture.outputRoot,
        blobSha256: sourceFixture.blobSha256,
        cid: sourceFixture.cid,
        totalValue: sourceFixture.totalValue,
        verifier: sourceFixture.verifier,
        paramsHash: sourceFixture.paramsHash,
      },
    })
    assert.equal(source.outputRoot, sourceFixture.outputRoot)
    assert.equal(source.entries.length, sourceFixture.entries.length)
    assert.notEqual(source.deploymentProvenance, `0x${'00'.repeat(32)}`)

    await assert.rejects(
      fetchCompositionSource({
        api: 'https://api.test',
        candidate,
        chain: {
          provenanceEnabled: false,
          stateIndex: 0n,
          checkpointId: 0n,
          acceptedAtBlock: 0n,
          freezeBlock: 0n,
          outputRoot: sourceFixture.outputRoot,
          blobSha256: sourceFixture.blobSha256,
          cid: sourceFixture.cid,
          totalValue: sourceFixture.totalValue,
          verifier: sourceFixture.verifier,
          paramsHash: sourceFixture.paramsHash,
        },
      }),
      /did not enable accepted-state provenance/
    )

    const bundle = await fetchCompositionBundle(
      'https://api.test',
      candidate.instanceId,
      '7'
    )
    assert.ok(bundle.provenance.cryptographic)
    assert.ok(bundle.provenance.governance)

    assert.throws(
      () =>
        requireCompatibleCandidate({ ...candidate, chainId: '8453' }, [
          candidate,
        ]),
      /same chain/
    )
    // Standard and weighted TrustGraph sources blend in one composition, so a
    // cross-type candidate is admitted without clearing the selection…
    assert.doesNotThrow(() =>
      requireCompatibleCandidate(
        {
          ...candidate,
          programId: SCORE_PROGRAM_IDS['trust-graph-weighted'],
        },
        [candidate]
      )
    )
    // …while any program outside the closed class fails even with the right
    // key encoding and chain.
    assert.throws(
      () =>
        requireCompatibleCandidate(
          {
            ...candidate,
            programId: SCORE_PROGRAM_IDS['contributions'],
          },
          [candidate]
        ),
      /standard and weighted TrustGraph allocation outputs/
    )
    const weightedCandidate = catalog.candidates.find(
      (row) => row.programName === 'trust-graph-weighted'
    )!
    assert.doesNotThrow(() =>
      requireCompatibleCandidate(weightedCandidate, [weightedCandidate])
    )

    const unavailable = new CompositionApiUnavailableError('not deployed', 404)
    assert.equal(unavailable.status, 404)

    // Eligibility classification: 'locked' is a permanent verdict (enableStateProvenance is
    // one-way and pre-first-root only), the other non-ready states are recoverable.
    assert.deepEqual(classifySourceEligibility(true, 3n), {
      status: 'ready',
      detail: null,
    })
    assert.equal(classifySourceEligibility(true, 0n).status, 'awaiting-root')
    assert.equal(classifySourceEligibility(false, 0n).status, 'enableable')
    const locked = classifySourceEligibility(false, 1n)
    assert.equal(locked.status, 'locked')
    assert.match(locked.detail ?? '', /Permanently ineligible/)
    assert.match(
      classifySourceEligibility(false, 0n).detail ?? '',
      /before the first accepted score root/
    )
  } finally {
    globalThis.fetch = originalFetch
  }
}

main()
  .then(() =>
    console.log(
      'composition catalog rolling fallback, authenticated source recovery, compatibility, and bundle provenance: ok'
    )
  )
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
