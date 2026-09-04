import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { rpcUpstreamUrl } from './rpc-upstream'

test('numbered browser RPC endpoints take precedence over the unsuffixed primary', () => {
  const environment = {
    RPC_URL_11155111: 'https://unsuffixed.example',
    RPC_URL_11155111_0: 'https://primary.example',
    RPC_URL_11155111_1: 'https://failover.example',
  }

  assert.equal(
    rpcUpstreamUrl('11155111', 0, environment),
    'https://primary.example'
  )
  assert.equal(
    rpcUpstreamUrl('11155111', 1, environment),
    'https://failover.example'
  )
})

test('endpoint zero retains the unsuffixed fallback', () => {
  assert.equal(
    rpcUpstreamUrl('11155111', 0, {
      RPC_URL_11155111: 'https://unsuffixed.example',
    }),
    'https://unsuffixed.example'
  )
  assert.equal(rpcUpstreamUrl('11155111', 1, {}), undefined)
})

test('malformed RPC JSON is classified as a client error', async () => {
  const route = await readFile(
    join(process.cwd(), 'app/api/rpc/[chainId]/route.ts'),
    'utf8'
  )

  const parse = route.indexOf('body = await request.json()')
  const malformed = route.indexOf('error instanceof SyntaxError', parse)
  const badRequest = route.indexOf('{ status: 400 }', malformed)
  const outerError = route.indexOf("console.error('RPC proxy error:'", parse)

  assert.ok(parse >= 0, 'RPC body parser is missing')
  assert.ok(malformed > parse, 'JSON parse failures are not handled locally')
  assert.ok(badRequest > malformed, 'JSON parse failures do not return 400')
  assert.ok(
    outerError > badRequest,
    'malformed JSON can still reach the proxy 500 handler'
  )
})
