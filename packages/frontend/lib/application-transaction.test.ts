import assert from 'node:assert/strict'
import test from 'node:test'

import type { Config } from '@wagmi/core'
import { mainnet, sepolia } from 'viem/chains'

import {
  ApplicationChainMismatchError,
  TransactionReplacementError,
  signApplicationTypedData,
  suggestFees,
  writeApplicationContractAndWait,
} from './application-transaction'

const account = '0x1111111111111111111111111111111111111111'
const hash = `0x${'ab'.repeat(32)}` as const
const replacementHash = `0x${'cd'.repeat(32)}` as const
const call = {
  address: '0x2222222222222222222222222222222222222222',
  abi: [
    {
      type: 'function',
      name: 'fund',
      stateMutability: 'payable',
      inputs: [],
      outputs: [],
    },
  ],
  functionName: 'fund',
  value: 123n,
} as const

const fixture = () => {
  let walletChain: number = sepolia.id
  const writes: {
    chain: { id: number }
    assertChainId: boolean
    value: bigint
  }[] = []
  const waits: { chainId: number; hash: string; confirmations: number }[] = []
  const signatures: unknown[] = []
  let onWalletRead: (() => void) | undefined
  let onWait: ((args: any) => void) | undefined
  const connector = {
    uid: 'fixture',
    getAccounts: async () => [account],
    getChainId: async () => {
      onWalletRead?.()
      return walletChain
    },
    getClient: async ({ chainId }: { chainId: number }) => ({
      chain: { id: chainId },
      writeContract: async (args: any) => {
        // Stand-in for the wallet's chain assertion; no provider/network is contacted.
        if (args.assertChainId && walletChain !== args.chain.id)
          throw new Error('Wallet chain changed')
        writes.push(args)
        return hash
      },
      signTypedData: async (args: unknown) => {
        signatures.push(args)
        return hash
      },
    }),
  }
  const config = {
    chains: [sepolia, mainnet],
    state: {
      status: 'connected',
      current: connector.uid,
      connections: new Map([
        [
          connector.uid,
          { accounts: [account], chainId: sepolia.id, connector },
        ],
      ]),
    },
    getClient: ({ chainId }: { chainId: number }) => ({
      chain: { id: chainId },
      waitForTransactionReceipt: async (args: any) => {
        waits.push({
          chainId,
          hash: args.hash,
          confirmations: args.confirmations,
        })
        onWait?.(args)
        return { status: 'success', transactionHash: args.hash }
      },
    }),
  } as unknown as Config
  return {
    config,
    writes,
    waits,
    signatures,
    setChain: (id: number) => {
      walletChain = id
    },
    onWalletRead: (callback: () => void) => {
      onWalletRead = callback
    },
    onWait: (callback: (args: any) => void) => {
      onWait = callback
    },
  }
}

test('wrong-chain wallet and wrong-chain caller cannot submit native value', async () => {
  const f = fixture()
  f.setChain(1)
  await assert.rejects(
    writeApplicationContractAndWait(f.config, sepolia, call),
    ApplicationChainMismatchError
  )
  f.setChain(sepolia.id)
  await assert.rejects(
    writeApplicationContractAndWait(f.config, sepolia, { ...call, chainId: 1 }),
    ApplicationChainMismatchError
  )
  assert.equal(f.writes.length, 0)
  assert.equal(f.waits.length, 0)
})

test('relayable signatures require the reviewed chain and account', async () => {
  const f = fixture()
  const message = {
    account,
    domain: { name: 'EAS', chainId: sepolia.id },
    types: { Vouch: [{ name: 'value', type: 'uint256' }] },
    primaryType: 'Vouch',
    message: { value: 1n },
  } as const
  await assert.rejects(
    signApplicationTypedData(f.config, sepolia, {
      ...message,
      domain: { ...message.domain, chainId: 1 },
    }),
    ApplicationChainMismatchError
  )
  f.setChain(1)
  await assert.rejects(
    signApplicationTypedData(f.config, sepolia, message),
    ApplicationChainMismatchError
  )
  f.setChain(sepolia.id)
  await assert.rejects(
    signApplicationTypedData(f.config, sepolia, {
      ...message,
      account: call.address,
    }),
    /account changed/
  )
  assert.equal(f.signatures.length, 0)
  assert.equal(await signApplicationTypedData(f.config, sepolia, message), hash)
  assert.equal(f.signatures.length, 1)
})

test('wallet switch between preflight and submission still requests a chain assertion', async () => {
  const f = fixture()
  let reads = 0
  f.onWalletRead(() => {
    if (++reads === 2) f.setChain(1)
  })
  await assert.rejects(
    writeApplicationContractAndWait(f.config, sepolia, call),
    /Wallet chain changed/
  )
  assert.equal(f.writes.length, 0)
})

test('every confirmation remains on the original chain after wallet switching', async () => {
  const f = fixture()
  const receipt = await writeApplicationContractAndWait(
    f.config,
    sepolia,
    call,
    {
      confirmations: 3,
      onTransactionSent: () => f.setChain(1),
    }
  )
  assert.equal(f.writes[0].chain.id, sepolia.id)
  assert.equal(f.writes[0].assertChainId, true)
  assert.equal(f.writes[0].value, 123n)
  assert.deepEqual(
    f.waits.map(({ chainId }) => chainId),
    [sepolia.id, sepolia.id, sepolia.id]
  )
  assert.equal(receipt.chainId, sepolia.id)
})

test('repricing follows the replacement hash but cancellation never reports success', async () => {
  const f = fixture()
  f.onWait((args) =>
    args.onReplaced({
      reason: 'repriced',
      transaction: { hash: replacementHash },
    })
  )
  const sent: string[] = []
  await writeApplicationContractAndWait(f.config, sepolia, call, {
    confirmations: 2,
    onTransactionSent: (hash) => sent.push(hash),
  })
  assert.deepEqual(sent, [hash, replacementHash])
  assert.equal(f.waits[1].hash, replacementHash)
  const cancelled = fixture()
  cancelled.onWait((args) => args.onReplaced({ reason: 'cancelled' }))
  await assert.rejects(
    writeApplicationContractAndWait(cancelled.config, sepolia, call),
    TransactionReplacementError
  )
})

test('a transaction prepared for another account is rejected before submission', async () => {
  const f = fixture()
  await assert.rejects(
    writeApplicationContractAndWait(f.config, sepolia, {
      ...call,
      account: call.address,
    }),
    /account changed/
  )
  assert.equal(f.writes.length, 0)
  assert.equal(f.waits.length, 0)
})

test('suggested fees follow recent blocks instead of a flat wallet tip', () => {
  const gwei = (value: number) => BigInt(Math.round(value * 1e9))
  // 2026-11-10 mainnet: 0.066 gwei basefee, median tips 0.002–0.46 gwei.
  const quiet = suggestFees({
    baseFeePerGas: [gwei(0.065), gwei(0.064), gwei(0.066)],
    reward: [[gwei(0.002)], [gwei(0.46)], [gwei(0.02)]],
  })
  // The median tip (0.02) is under the floor, so the floor wins; the cap is 2 × next basefee + tip.
  assert.deepEqual(quiet, {
    maxPriorityFeePerGas: gwei(0.05),
    maxFeePerGas: gwei(0.066) * 2n + gwei(0.05),
  })
  // A busy stretch tips the median of the recent medians.
  const busy = suggestFees({
    baseFeePerGas: [gwei(20), gwei(22)],
    reward: [[gwei(1)], [gwei(3)], [gwei(2)]],
  })
  assert.equal(busy?.maxPriorityFeePerGas, gwei(2))
  assert.equal(busy?.maxFeePerGas, gwei(22) * 2n + gwei(2))
  // No history (a pre-1559 chain): nothing to suggest, the wallet prices it.
  assert.equal(suggestFees({ baseFeePerGas: [] }), undefined)
})

test('a call that sets its own fees is sent unchanged', async () => {
  const f = fixture()
  await writeApplicationContractAndWait(f.config, sepolia, {
    ...call,
    maxFeePerGas: 7n,
    maxPriorityFeePerGas: 3n,
  })
  const sent = f.writes[0] as unknown as Record<string, unknown>
  assert.equal(sent.maxFeePerGas, 7n)
  assert.equal(sent.maxPriorityFeePerGas, 3n)
})
