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
