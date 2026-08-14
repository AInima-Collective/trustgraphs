import assert from 'node:assert/strict'

import { type Address, type Hex, decodeFunctionData } from 'viem'

import {
  weightedCreateArgs,
  weightedPriorParamsControllerAbi,
  weightedRotationPayload,
  weightedTrustgraphsFactoryAbi,
} from './contracts'
import {
  MAX_WEIGHTED_IMPORT_BYTES,
  WEIGHTED_INPUT_SCHEMA,
  WeightedEnsResolutionChangedError,
  WeightedImportError,
  equalWeightCsv,
  parseWeightedSource,
  recheckWeightedSource,
  requiresEnsResolution,
  resolveAddressOnlyWeightedSource,
  resolveWeightedSource,
  weightedExportArtifacts,
} from './import'

const A = '0x1111111111111111111111111111111111111111' as Address
const B = '0x2222222222222222222222222222222222222222' as Address
const C = '0x3333333333333333333333333333333333333333' as Address
const ROOT =
  '0x3bfa55c8c22dc55892da0439ba84748c4072b323d2ae036cb4088a60f46095cd'
const MANIFEST =
  '0x544757500001000000000000000a0000000311111111111111111111111111111111111111110a47a3c77282f68522222222222222222222222222222222222222220291e8f1dca0bda13333333333333333333333333333333333333333010729fa58404bda'
const SHA = '0xcabfa154d35790a2decec957f63391a8ce6347a617ead7378ef2190fecc9e45b'
const HASH = `0x${'44'.repeat(32)}` as Hex

const anchor = { chainId: 1, blockNumber: 100n, blockHash: HASH }
const neverResolve = async () => null

const expectIssue = (
  action: () => unknown,
  code: WeightedImportError['issues'][number]['code'],
  field?: string
) => {
  assert.throws(action, (error: unknown) => {
    assert(error instanceof WeightedImportError)
    assert(error.issues.every((issue) => issue.field.length > 0))
    assert(error.issues.some((issue) => issue.code === code))
    if (field) assert(error.issues.some((issue) => issue.field === field))
    return true
  })
}

const csv =
  '\uFEFFaccount,weight\r\n' + `${C},1\r\n` + `${A},10\r\n` + `${B},2.5\r\n`

const main = async () => {
  const parsedCsv = parseWeightedSource(csv, 'csv', 10n)
  const imported = await resolveWeightedSource(
    parsedCsv,
    anchor,
    neverResolve,
    {
      author: 'Fixture author',
      license: 'CC0-1.0',
      transform: 'No transform',
    }
  )

  assert.equal(
    imported.canonicalCsv,
    `account,weight\n${A},10\n${B},2.5\n${C},1\n`,
    'canonical CSV removes BOM/CRLF, address-sorts, and ends in one LF'
  )
  assert.equal(
    imported.canonicalJson,
    `{"schema":"${WEIGHTED_INPUT_SCHEMA}","chainId":"10","entries":[{"account":"${A}","weight":"10"},{"account":"${B}","weight":"2.5"},{"account":"${C}","weight":"1"}]}`,
    'canonical JSON is minified, property-stable, sorted, and has no terminal LF'
  )
  assert(!imported.canonicalJson.endsWith('\n'))
  assert.equal(imported.priorRoot, ROOT)
  assert.equal(imported.manifest, MANIFEST)
  assert.equal(imported.manifestSha256, SHA)
  assert.deepEqual(
    imported.normalizedEntries.map((entry) => entry.weight.toString()),
    ['740740740740740741', '185185185185185185', '74074074074074074']
  )
  assert.equal(requiresEnsResolution(parsedCsv), false)

  const malformedAccount = parseWeightedSource(
    'account,weight\nnot-an-account,1\n',
    'csv',
    10n
  )
  assert.equal(
    requiresEnsResolution(malformedAccount),
    false,
    'a malformed field is rejected locally instead of creating an ENS dependency'
  )
  await assert.rejects(
    resolveAddressOnlyWeightedSource(malformedAccount),
    (error: unknown) => {
      assert(error instanceof WeightedImportError)
      assert.equal(error.issues[0].code, 'account')
      return true
    }
  )

  const addressOnly = await resolveAddressOnlyWeightedSource(parsedCsv, {
    author: 'Fixture author',
    license: 'CC0-1.0',
    transform: 'No transform',
  })
  assert.equal(addressOnly.manifest, imported.manifest)
  assert.deepEqual(addressOnly.ensResolutions, [])

  const exports = weightedExportArtifacts(imported)
  assert.deepEqual(
    exports.map((artifact) => [artifact.name, artifact.label, artifact.type]),
    [
      ['weighted-prior.csv', 'CSV', 'text/csv;charset=utf-8'],
      ['weighted-prior.json', 'JSON', 'application/json'],
      ['weighted-prior.tgwp', 'TGWP', 'application/octet-stream'],
      ['weighted-prior-provenance.json', 'Provenance', 'application/json'],
    ],
    'copy/export names and media types stay explicit and deterministic'
  )
  assert.equal(exports[0].body, imported.canonicalCsv)
  assert.equal(exports[1].body, imported.canonicalJson)
  assert.equal(
    Buffer.from(exports[2].body as Uint8Array).toString('hex'),
    imported.manifest.slice(2)
  )
  assert.equal(exports[3].body, imported.provenanceJson)

  const parsedJson = parseWeightedSource(imported.canonicalJson, 'json', 10n)
  const fromJson = await resolveWeightedSource(parsedJson, anchor, neverResolve)
  assert.equal(fromJson.manifest, imported.manifest)
  assert.equal(fromJson.priorRoot, imported.priorRoot)
  assert.equal(fromJson.manifestSha256, imported.manifestSha256)

  const ties = await resolveWeightedSource(
    parseWeightedSource(`account,weight\n${C},1\n${B},1\n${A},1\n`, 'csv', 10n),
    anchor,
    neverResolve
  )
  assert.deepEqual(
    ties.normalizedEntries.map((entry) => entry.weight.toString()),
    ['333333333333333334', '333333333333333333', '333333333333333333'],
    'Hamilton ties award the missing unit to the ascending address'
  )

  for (const invalid of [
    '1.0',
    '1e3',
    '-1',
    '+1',
    '00.1',
    '0',
    '1.1234567890123456789',
  ]) {
    expectIssue(
      () =>
        parseWeightedSource(`account,weight\n${A},${invalid}\n`, 'csv', 10n),
      'weight'
    )
  }
  expectIssue(
    () =>
      parseWeightedSource(
        JSON.stringify({
          schema: WEIGHTED_INPUT_SCHEMA,
          chainId: '1',
          entries: [{ account: A, weight: '1' }],
        }),
        'json',
        10n
      ),
    'chain',
    'chainId'
  )
  expectIssue(
    () =>
      parseWeightedSource(
        JSON.stringify({
          schema: WEIGHTED_INPUT_SCHEMA,
          chainId: '10',
          entries: [{ account: A, weight: 1.5 }],
        }),
        'json',
        10n
      ),
    'weight'
  )
  expectIssue(
    () =>
      parseWeightedSource(
        `account,weight\n${Array.from(
          { length: 2049 },
          (_, index) => `0x${(index + 1).toString(16).padStart(40, '0')},1`
        ).join('\n')}\n`,
        'csv',
        10n
      ),
    'count'
  )
  expectIssue(
    () =>
      parseWeightedSource(
        new Uint8Array(MAX_WEIGHTED_IMPORT_BYTES + 1),
        'csv',
        10n
      ),
    'file-size'
  )

  await assert.rejects(
    resolveWeightedSource(
      parseWeightedSource(
        `account,weight\n${A},1\nexample.eth,1\n`,
        'csv',
        10n
      ),
      anchor,
      async () => A
    ),
    (error: unknown) => {
      assert(error instanceof WeightedImportError)
      assert.equal(error.issues[0].code, 'duplicate')
      return true
    }
  )

  const ensSource = parseWeightedSource(
    `account,weight\nalice.eth,1\n${B},1\n`,
    'csv',
    10n
  )
  assert.equal(requiresEnsResolution(ensSource), true)
  const ensPreview = await resolveWeightedSource(
    ensSource,
    anchor,
    async () => A
  )
  assert(!ensPreview.canonicalCsv.includes('alice.eth'))
  assert(!ensPreview.manifest.includes('alice'))
  assert.equal(ensPreview.ensResolutions[0].blockNumber, '100')
  assert.equal(ensPreview.ensResolutions[0].blockHash, HASH)

  await assert.rejects(
    resolveWeightedSource(ensSource, anchor, async () => {
      throw new Error('RPC unavailable')
    }),
    (error: unknown) => {
      assert(error instanceof WeightedImportError)
      assert.equal(error.issues[0].field, 'entries[1].account')
      assert.match(error.issues[0].message, /RPC unavailable/)
      return true
    }
  )

  const freshAnchor = {
    chainId: 1,
    blockNumber: 200n,
    blockHash: `0x${'55'.repeat(32)}` as Hex,
  }
  await assert.rejects(
    recheckWeightedSource(ensPreview, freshAnchor, async () => C),
    (error: unknown) => {
      assert(error instanceof WeightedEnsResolutionChangedError)
      assert.equal(error.changes[0].previousAddress.toLowerCase(), A)
      assert.equal(error.changes[0].currentAddress.toLowerCase(), C)
      assert.notEqual(error.rebuilt.manifest, ensPreview.manifest)
      assert(!error.rebuilt.canonicalJson.includes('alice.eth'))
      return true
    }
  )
  assert.equal(
    await recheckWeightedSource(ensPreview, freshAnchor, async () => A),
    ensPreview,
    'an unchanged fresh resolution preserves the exact reviewed provenance bytes'
  )

  assert.equal(
    equalWeightCsv([C, A, B]),
    `account,weight\n${A},1\n${B},1\n${C},1\n`,
    'binary-instance prefill is explicitly equal-weight and deterministic'
  )

  const createFields = {
    name: 'New weighted instance',
    metadataURI: 'ipfs://metadata',
    dampingFp: 850_000_000_000_000_000n,
    toleranceFp: 0n,
    maxIterations: 40,
    minWeight: 0n,
    maxWeight: 100n,
    admin: A,
    epochLength: 100n,
    withDistributor: false,
    distributorToken: '0x0000000000000000000000000000000000000000' as Address,
    salt: `0x${'66'.repeat(32)}` as Hex,
  }
  const createArgs = weightedCreateArgs(createFields, imported)
  assert.equal(createArgs.manifest, MANIFEST)
  assert.equal(createArgs.metadataDigest, imported.metadataDigest)
  assert.equal(
    createArgs.params.priorCount,
    0,
    'factory-derived commitments stay zero in args'
  )

  const rotation = decodeFunctionData({
    abi: weightedPriorParamsControllerAbi,
    data: weightedRotationPayload(imported),
  })
  assert.equal(rotation.functionName, 'proposePrior')
  assert.equal(rotation.args[0], MANIFEST)
  assert.equal(rotation.args[1], imported.metadataDigest)

  // Keep the ABI tuple itself executable by viem and pinned to the same manifest bytes #53 accepts.
  assert.equal(
    weightedTrustgraphsFactoryAbi.some(
      (item) => item.type === 'function' && item.name === 'createInstance'
    ),
    true
  )

  console.log(
    'weighted-prior importer, provenance, ENS freeze, and payloads: ok'
  )
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
