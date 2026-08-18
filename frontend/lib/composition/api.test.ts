import assert from 'node:assert/strict'

import {
  SCORE_OUTPUT_DOMAIN_IDS,
  SCORE_PROGRAM_IDS,
  type ScoreProgramProvenance,
} from '../score-program'
import {
  CompositionApiUnavailableError,
  type CompositionCandidate,
  fetchCompositionBundle,
  fetchCompositionCandidates,
  fetchCompositionSource,
  requireCompatibleCandidate,
} from './api'
import { compositionGoldenFixture } from './fixture'

const originalFetch = globalThis.fetch
const sourceFixture = compositionGoldenFixture().sources[0]!
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
          ],
          pagination: { total: 1 },
        })
      }
      if (url === 'https://api.test/weighted-priors?limit=200&offset=0') {
        return json({ error: 'route not deployed' }, 404)
      }
      if (url === `https://api.test/merkle/${candidate.snapshot}/current`) {
        return json({
          tree: {
            root: sourceFixture.outputRoot,
            ipfsHash: sourceFixture.blobSha256,
            ipfsHashCid: sourceFixture.cid,
            numAccounts: sourceFixture.entries.length,
            totalValue: sourceFixture.totalValue.toString(),
            blockNumber: sourceFixture.freezeBlock.toString(),
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
    assert.equal(catalog.candidates.length, 1)
    assert.equal(catalog.candidates[0]!.snapshot, candidate.snapshot)
    assert.match(catalog.warnings[0]!, /not deployed/)

    const source = await fetchCompositionSource({
      api: 'https://api.test',
      candidate,
      chain: {
        provenanceEnabled: true,
        stateIndex: sourceFixture.stateIndex,
        checkpointId: sourceFixture.checkpointId,
        acceptedAtBlock: sourceFixture.acceptedAtBlock,
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
    assert.throws(
      () =>
        requireCompatibleCandidate(
          {
            ...candidate,
            programId: SCORE_PROGRAM_IDS['trust-graph-weighted'],
          },
          [candidate]
        ),
      /one admitted score program/
    )

    const unavailable = new CompositionApiUnavailableError('not deployed', 404)
    assert.equal(unavailable.status, 404)
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
