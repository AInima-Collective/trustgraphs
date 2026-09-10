import assert from 'node:assert/strict'
import test from 'node:test'

import { createConfig, http, injected, switchChain } from '@wagmi/core'
import { mainnet, sepolia } from 'viem/chains'

import { requestApplicationChainSwitch } from './wallet-switch'

test('a rejected wallet switch is cancellation, with no add-network retry', async () => {
  let attempts = 0
  const result = await requestApplicationChainSwitch(async () => {
    attempts++
    throw { cause: { code: 4001 } }
  }, 'Sepolia')
  assert.equal(attempts, 1)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.cancelled, true)
})

test('a single active-connector request surfaces other failures with recovery guidance', async () => {
  const success = await requestApplicationChainSwitch(
    async () => undefined,
    'Sepolia'
  )
  assert.deepEqual(success, { ok: true })
  let attempts = 0
  const failed = await requestApplicationChainSwitch(async () => {
    attempts++
    throw { code: -32603 }
  }, 'Ethereum')
  assert.equal(attempts, 1)
  assert.equal(failed.ok, false)
  if (!failed.ok) {
    assert.equal(failed.cancelled, false)
    assert.match(failed.message, /Retry or select it in your wallet/)
  }
})

test('the active injected connector adds a network only for the unknown-chain response', async () => {
  for (const code of [4001, 4902, -32603]) {
    const requests: string[] = []
    let currentChain: number = mainnet.id
    const config = createConfig({
      chains: [sepolia, mainnet],
      connectors: [injected()],
      transports: { [sepolia.id]: http(), [mainnet.id]: http() },
      ssr: true,
    })
    const connector = config.connectors[0]!
    connector.getProvider = async () =>
      ({
        on: () => {},
        removeListener: () => {},
        request: async ({ method }: { method: string }) => {
          requests.push(method)
          if (method === 'eth_chainId') return `0x${currentChain.toString(16)}`
          if (method === 'wallet_switchEthereumChain') throw { code }
          if (method === 'wallet_addEthereumChain') {
            currentChain = sepolia.id
            return null
          }
          throw new Error(`Unexpected provider request: ${method}`)
        },
      }) as unknown as Awaited<ReturnType<typeof connector.getProvider>>
    config.setState((state) => ({
      ...state,
      status: 'connected',
      current: connector.uid,
      connections: new Map([
        [
          connector.uid,
          {
            accounts: ['0x1111111111111111111111111111111111111111'],
            chainId: mainnet.id,
            connector,
          },
        ],
      ]),
    }))
    const result = await requestApplicationChainSwitch(
      () => switchChain(config, { connector, chainId: sepolia.id }),
      'Sepolia'
    )
    assert.equal(
      requests.filter((method) => method === 'wallet_addEthereumChain').length,
      code === 4902 ? 1 : 0
    )
    assert.equal(result.ok, code === 4902)
  }
})
