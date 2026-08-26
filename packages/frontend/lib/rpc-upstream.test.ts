import assert from 'node:assert/strict'
import test from 'node:test'

import { rpcUpstreamUrl } from './rpc-upstream'

test('numbered browser RPC endpoints take precedence over the legacy primary', () => {
  const environment = {
    RPC_URL_11155111: 'https://legacy.example',
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

test('endpoint zero retains the legacy unsuffixed fallback', () => {
  assert.equal(
    rpcUpstreamUrl('11155111', 0, {
      RPC_URL_11155111: 'https://legacy.example',
    }),
    'https://legacy.example'
  )
  assert.equal(rpcUpstreamUrl('11155111', 1, {}), undefined)
})
