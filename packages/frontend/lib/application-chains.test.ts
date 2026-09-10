import assert from 'node:assert/strict'
import test from 'node:test'

import { mainnet } from 'viem/chains'

import {
  applicationAndEnsChains,
  applicationChain,
  applicationEnvironmentLabel,
  applicationRpcChainIds,
  applicationTarget,
} from './application-chains'

test('deployment target, explorer, and read-proxy routing agree', () => {
  assert.equal(applicationChain('mainnet').id, 1)
  assert.equal(
    applicationChain('mainnet').blockExplorers?.default.url,
    'https://etherscan.io'
  )
  assert.equal(applicationChain('sepolia').id, 11155111)
  assert.equal(applicationChain('local').id, 31337)
  assert.deepEqual(applicationRpcChainIds('mainnet'), ['1'])
  assert.deepEqual(applicationRpcChainIds('sepolia'), ['1', '11155111'])
  assert.deepEqual(applicationRpcChainIds('local'), ['1'])
  assert.equal(applicationEnvironmentLabel('mainnet'), 'Ethereum mainnet')
  assert.equal(applicationEnvironmentLabel('sepolia'), 'Sepolia testnet')
  assert.throws(
    () => applicationTarget('base'),
    /Unsupported application chain/
  )
  assert.throws(
    () => applicationTarget('toString'),
    /Unsupported application chain/
  )
})

test('ENS does not overwrite a mainnet application transport', () => {
  const application = {
    ...mainnet,
    rpcUrls: { default: { http: ['https://application.example/rpc'] } },
  }
  const chains = applicationAndEnsChains(application, mainnet)
  assert.equal(chains.length, 1)
  assert.equal(chains[0], application)
  assert.deepEqual(
    applicationAndEnsChains(applicationChain('sepolia'), mainnet).map(
      ({ id }) => id
    ),
    [11155111, 1]
  )
})
