import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('runtime schemas are registered before server-side network attestation prefetch', async () => {
  const page = await readFile(
    new URL('../app/networks/[id]/page.tsx', import.meta.url),
    'utf8'
  )

  assert.match(
    page,
    /import \{ registerSchemas \} from '@\/lib\/schema-registry'/
  )

  const registration = page.indexOf('registerSchemas(network.schemas)')
  const networkPrefetch = page.indexOf(
    'ponderQueries.network(network.contracts.merkleSnapshot)'
  )

  assert.ok(registration >= 0, 'runtime network schema is not registered')
  assert.ok(networkPrefetch >= 0, 'network attestation prefetch is missing')
  assert.ok(
    registration < networkPrefetch,
    'network attestations can be decoded before their runtime schema is registered'
  )
})

test('request-specific permissionless network subpages stay dynamic', async () => {
  const routes = [
    '../app/networks/[id]/settings/page.tsx',
    '../app/networks/[id]/rewards/page.tsx',
    '../app/networks/[id]/contributions/page.tsx',
  ]

  for (const route of routes) {
    const page = await readFile(new URL(route, import.meta.url), 'utf8')
    assert.match(page, /export const dynamic = 'force-dynamic'/, route)
    assert.doesNotMatch(page, /generateStaticParams/, route)
    assert.doesNotMatch(page, /export const revalidate/, route)
    assert.match(page, /await searchParams/, route)
    assert.match(page, /await getNetwork\(id\)/, route)
  }
})
