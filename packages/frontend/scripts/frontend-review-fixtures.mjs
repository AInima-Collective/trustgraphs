/** Local read-only API data for the browser smoke runner, never imported by the app. */
import { createServer } from 'node:http'

import { keccak256, stringToHex, zeroHash } from 'viem'

const address = (value) => `0x${value.toString(16).padStart(40, '0')}`
export const reviewContracts = {
  factory: address(100),
  governedFactory: address(101),
  snapshot: address(102),
  accumulator: address(103),
  governor: address(104),
  safe: address(105),
  distributor: address(108),
}
export const reviewAccounts = [
  '0x1000000000000000000000000000000000000001',
  '0x2000000000000000000000000000000000000002',
]
const entries = reviewAccounts.map((account, index) => ({
  account,
  value: `${(index ? 4_000n : 6_000n) * 10n ** 18n}`,
  proof: [],
  sent: index ? 0 : 1,
  received: index ? 1 : 0,
  agents: [],
}))
const scoreProgram = {
  programId: keccak256(stringToHex('trust-graph')),
  programName: 'trust-graph',
  outputDomain: keccak256(
    stringToHex('trustgraphs.output.trust-graph-account.v1')
  ),
  outputDomainName: 'trust-graph-account-v1',
  keyEncoding: 'eip155-address',
  instanceId: `0x${'11'.repeat(32)}`,
  verifier: address(106),
  registryOrAccumulator: reviewContracts.accumulator,
  paramsHash: zeroHash,
  source: {
    kind: 'instance-registered',
    registry: address(107),
    blockNumber: '1',
    logIndex: 0,
    transactionHash: zeroHash,
  },
}

export async function startReviewFixtureServer() {
  const writes = []
  const server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Allow-Headers', 'content-type')
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    response.setHeader('Content-Type', 'application/json')
    const reply = (body, status = 200) => {
      response.statusCode = status
      response.end(JSON.stringify(body))
    }
    if (request.method === 'OPTIONS') return reply({})
    const path = new URL(request.url, 'http://localhost').pathname
    if (request.method === 'POST') {
      if (path !== '/rpc') {
        writes.push(`${request.method} ${path}`)
        return reply({ error: 'The review API is read-only' }, 405)
      }
      let body = ''
      for await (const chunk of request) body += chunk
      try {
        const rpc = (call) => {
          const response = { jsonrpc: '2.0', id: call.id }
          if (/send|sign|wallet_|personal_/i.test(call.method)) {
            writes.push(call.method)
            return {
              ...response,
              error: { code: -32601, message: 'Writes are disabled' },
            }
          }
          const results = {
            eth_chainId: '0x7a69',
            net_version: '31337',
            eth_blockNumber: '0x1',
            eth_getBalance: '0x0',
            eth_getCode: '0x',
            eth_call: zeroHash,
            eth_gasPrice: '0x1',
            eth_maxPriorityFeePerGas: '0x1',
          }
          return call.method in results
            ? { ...response, result: results[call.method] }
            : {
                ...response,
                error: {
                  code: -32601,
                  message: 'Read not supplied by fixture',
                },
              }
        }
        const payload = JSON.parse(body)
        return reply(Array.isArray(payload) ? payload.map(rpc) : rpc(payload))
      } catch {
        return reply({ error: 'Invalid review RPC request' }, 400)
      }
    }
    if (path === '/instances')
      return reply({
        instances: [],
        pagination: { limit: 100, offset: 0, total: 0 },
      })
    if (path === `/score-programs/${reviewContracts.snapshot}`)
      return reply({ scoreProgram })
    if (path === '/status')
      return reply({
        local: { id: 31337, block: { number: 1, timestamp: 1700000000 } },
      })
    if (path.endsWith('/db')) return reply({ rows: [] })
    if (path === `/network/${reviewContracts.snapshot}`)
      return reply({ accounts: entries, attestations: [], scoreProgram })
    if (path === `/merkle/${reviewContracts.snapshot}/current`)
      return reply({
        tree: {
          root: `0x${'11'.repeat(32)}`,
          ipfsHash: zeroHash,
          ipfsHashCid: 'bafyreviewfixture',
          numAccounts: entries.length,
          totalValue: `${10_000n * 10n ** 18n}`,
          sources: [],
          blockNumber: '1',
          timestamp: '1700000000',
        },
        entries,
        scoreProgram,
      })
    return reply({ error: 'Not supplied by the browser review fixture' }, 404)
  })
  // The app can try its preferred websocket transport before HTTP fallback.
  // Reject upgrades immediately instead of leaving a socket waiting.
  server.on('upgrade', (_request, socket) => socket.destroy())
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    writes,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(resolve)
      }),
  }
}
