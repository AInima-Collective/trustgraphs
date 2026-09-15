import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (path: string) =>
  readFile(new URL(path, import.meta.url), 'utf8')

test('strict lanes are factory-discovered and never sourced from annotations', async () => {
  const config = await source('../../ponder.config.ts')
  assert.match(config, /name: 'OffchainEasLaneCreated'/)
  assert.match(config, /parameter: 'registry'/)
  assert.match(
    config,
    /easOffchainAnchorRegistry:[\s\S]*easOffchainRegistries\(\)/
  )
  assert.doesNotMatch(
    config,
    /easOffchainAnchorRegistry:[\s\S]{0,300}deploymentSummary\.networks/
  )
})

test('bundle-derived rows are independently verified in Ponder reorg state', async () => {
  const handler = await source('../eas-offchain.ts')
  const factory = await source('../factory.ts')
  const schema = await source('../../ponder.schema.ts')
  assert.match(handler, /validateSignedBundle\(bundle\)/)
  assert.match(factory, /headDomainSeparator: paramsHeadDomain/)
  assert.match(schema, /headDomainSeparator: t\.hex\(\)\.notNull\(\)/)
  assert.match(handler, /payloadCommitment\(bytes\)/)
  assert.match(handler, /event\.args\.foldIndex !== lane\.anchorCount/)
  assert.match(handler, /prefixHeads\(payload\)/)
  assert.match(handler, /const previousCount = previous\?\.count \?\? 0n/)
  assert.match(
    handler,
    /lane\.aggregateEntryCount - previousCount \+ event\.args\.count/
  )
  assert.doesNotMatch(handler, /const oldCount = previous\?\.count/)
  assert.match(handler, /context\.db\.insert\(easOffchainMutation\)/)
  assert.match(
    handler,
    /id: `\$\{event\.id\}-\$\{sequence\}-\$\{entry\.kind\}-/
  )
  assert.match(handler, /firstAnchorFoldIndex: firstAnchor\.foldIndex/)
  assert.match(schema, /export const easOffchainLane = onchainTable/)
  assert.match(schema, /export const easOffchainAnchor = onchainTable/)
  assert.match(schema, /export const easOffchainNode = onchainTable/)
  assert.doesNotMatch(handler, /offchainDb/)
})

test('strict lane APIs expose config, head, history, mutations, CID health and utilization', async () => {
  const api = await source('./eas-offchain.ts')
  const routes = await source('./index.ts')
  for (const path of [
    "'/:registry/config'",
    "'/:registry/utilization'",
    "'/:registry/nodes'",
    "'/:registry/nodes/:nodeId'",
    "'/:registry/nodes/:nodeId/history'",
    "'/:registry/nodes/:nodeId/mutations'",
    "'/:registry/cids/:commitment'",
  ]) {
    assert.ok(api.includes(path), `missing ${path}`)
  }
  assert.match(routes, /app\.route\('\/eas-offchain', easOffchain\)/)
  assert.match(api, /logEntries: json\(mutations\)/)
})

test('normal network API reconciles both lanes and publishes verified provenance', async () => {
  const api = await source('./network.ts')
  assert.match(
    api,
    /currentTimedVouches\(\s*\[\s*\.\.\.lane1Rows,\s*\.\.\.strictRows,?\s*\]\s*\)/
  )
  assert.match(api, /source: 'on-chain-eas'/)
  assert.match(api, /source: 'off-chain-eas'/)
  assert.match(api, /storageHealthy: true/)
  assert.match(api, /Strict node .* is unavailable or invalid/)
  assert.match(api, /incomplete derived mutation log/)
})

test('network and account APIs resolve isolated weighted instances by snapshot', async () => {
  const lookup = await source('./snapshot-network.ts')
  assert.match(lookup, /weightedPriorInstance/)
  assert.match(
    lookup,
    /select\(\{ schemaUid: weightedPriorInstance\.schemaUid \}\)[\s\S]*?from\(weightedPriorInstance\)[\s\S]*?weightedPriorInstance\.snapshot/
  )
  assert.match(
    lookup,
    /select\(\{ resolver: weightedPriorInstance\.resolver \}\)[\s\S]*?from\(weightedPriorInstance\)[\s\S]*?weightedPriorInstance\.snapshot/
  )
  // Both route files go through the shared lookup rather than the static catalog alone.
  for (const route of ['./network.ts', './account.ts']) {
    const api = await source(route)
    assert.match(api, /schemaUidsForSnapshot\(/, route)
    assert.match(api, /resolverForSnapshot\(/, route)
  }
})

test('snapshot work checkpoints update the same reorg-reverted checkpoint row', async () => {
  const handler = await source('../anchor.ts')
  assert.match(handler, /merkleSnapshot:AnchorWorkCheckpointed/)
  assert.match(handler, /set\(\{ workCount: event\.args\.workCount \}\)/)
})
