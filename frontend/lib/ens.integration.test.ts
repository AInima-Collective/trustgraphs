import assert from 'node:assert/strict'

import { createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'

const rpcUrl = process.env.RPC_URL_1

const main = async () => {
  if (!rpcUrl) {
    console.log('ENS mainnet integration tests skipped (RPC_URL_1 is unset)')
    return
  }

  const client = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl, { timeout: 15_000 }),
  })

  const universalResolver = await client.getEnsAddress({
    name: 'ur.integration-tests.eth',
  })
  assert.equal(
    universalResolver?.toLowerCase(),
    '0x2222222222222222222222222222222222222222'
  )

  const ccipRead = await client.getEnsAddress({
    name: 'test.offchaindemo.eth',
  })
  assert.equal(
    ccipRead?.toLowerCase(),
    '0x779981590e7ccc0cfae8040ce7151324747cdb97'
  )

  console.log('ENS Universal Resolver and CCIP Read integration tests passed')
}

void main()
