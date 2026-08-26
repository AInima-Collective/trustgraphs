import { NextRequest, NextResponse } from 'next/server'
import { mainnet } from 'viem/chains'

import { CHAIN } from '@/lib/config'
import { rpcUpstreamUrl } from '@/lib/rpc-upstream'

const MAX_RPC_BODY_BYTES = 256 * 1024
const MAX_RPC_BATCH_SIZE = 50
const DEVELOPMENT_MAINNET_RPC_URLS = [
  'https://ethereum-rpc.publicnode.com',
  'https://public.1rpc.io/eth',
] as const

const PUBLIC_CHAIN_IDS: Record<string, string> = {
  sepolia: '11155111',
}

// The browser uses the configured deployment chain plus Ethereum mainnet for ENS resolution.
// Wallet writes go through the connected wallet's EIP-1193 provider and must never reach this
// credentialed, read-only proxy.
const allowedChainIds = new Set([
  String(mainnet.id),
  ...(PUBLIC_CHAIN_IDS[CHAIN] ? [PUBLIC_CHAIN_IDS[CHAIN]] : []),
])
const READ_RPC_METHODS = new Set([
  'eth_blockNumber',
  'eth_call',
  'eth_chainId',
  'eth_estimateGas',
  'eth_feeHistory',
  'eth_gasPrice',
  'eth_getBalance',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'eth_getBlockReceipts',
  'eth_getCode',
  'eth_getLogs',
  'eth_getProof',
  'eth_getStorageAt',
  'eth_getTransactionByHash',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_maxPriorityFeePerGas',
  'net_version',
])

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ chainId: string }> }
) {
  try {
    // Get chain ID from path parameters
    const { chainId } = await params
    const id = Number(request.nextUrl.searchParams.get('id') || 0)

    if (!chainId) {
      return NextResponse.json(
        { error: 'Chain ID is required' },
        { status: 400 }
      )
    }

    // Validate chain ID is a number
    if (!/^\d+$/.test(chainId)) {
      return NextResponse.json(
        { error: 'Chain ID must be a valid number' },
        { status: 400 }
      )
    }
    if (!allowedChainIds.has(chainId)) {
      return NextResponse.json(
        { error: `RPC chain ${chainId} is not allowed` },
        { status: 403 }
      )
    }

    // Get the private RPC URL from environment variables based on chain ID
    const configuredRpcUrl = rpcUpstreamUrl(chainId, id)
    // Keep browser clients on one same-origin transport. Developers should not
    // need a paid mainnet RPC just to exercise ENS locally, while production
    // remains explicitly configured and never depends on public capacity.
    const rpcUrls = configuredRpcUrl
      ? [configuredRpcUrl]
      : process.env.NODE_ENV !== 'production' && chainId === String(mainnet.id)
        ? DEVELOPMENT_MAINNET_RPC_URLS
        : []

    if (!rpcUrls.length) {
      return NextResponse.json(
        { error: `RPC URL not configured for chain ${chainId}` },
        { status: 503 }
      )
    }

    const contentLength = Number(request.headers.get('content-length') || 0)
    if (contentLength > MAX_RPC_BODY_BYTES) {
      return NextResponse.json(
        { error: 'RPC request body is too large' },
        { status: 413 }
      )
    }

    // Malformed JSON is a client error, not a failed proxy invocation. Keep it out of the outer
    // error path so empty or truncated requests do not become noisy 500s or trigger RPC failover.
    let body: unknown
    try {
      body = await request.json()
    } catch (error) {
      if (error instanceof SyntaxError) {
        return NextResponse.json(
          { error: 'Invalid JSON request body' },
          { status: 400 }
        )
      }
      throw error
    }

    // Validate that it's a proper JSON-RPC request
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      )
    }

    if (JSON.stringify(body).length > MAX_RPC_BODY_BYTES) {
      return NextResponse.json(
        { error: 'RPC request body is too large' },
        { status: 413 }
      )
    }

    // For batch requests, validate each item
    const requests = Array.isArray(body) ? body : [body]

    if (!requests.length || requests.length > MAX_RPC_BATCH_SIZE) {
      return NextResponse.json(
        { error: 'Invalid JSON-RPC batch size' },
        { status: 400 }
      )
    }

    for (const req of requests) {
      if (
        !req ||
        typeof req !== 'object' ||
        typeof req.method !== 'string' ||
        req.id === undefined ||
        req.jsonrpc !== '2.0'
      ) {
        return NextResponse.json(
          { error: 'Invalid JSON-RPC request format' },
          { status: 400 }
        )
      }
      if (!READ_RPC_METHODS.has(req.method)) {
        return NextResponse.json(
          { error: `RPC method ${req.method} is not allowed` },
          { status: 403 }
        )
      }
    }

    const requestBody = JSON.stringify(body)
    let lastFailure = 'No RPC endpoint responded'
    for (const rpcUrl of rpcUrls) {
      try {
        const response = await fetch(rpcUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: requestBody,
          signal: AbortSignal.timeout(10_000),
        })

        if (!response.ok) {
          lastFailure = `upstream returned ${response.status}`
          continue
        }

        const data = await response.json()
        return NextResponse.json(data)
      } catch (error) {
        lastFailure =
          error instanceof Error ? error.message : 'Unknown upstream error'
      }
    }

    console.error(`RPC request failed for chain ${chainId}: ${lastFailure}`)
    return NextResponse.json(
      { error: `RPC request failed for chain ${chainId}` },
      { status: 502 }
    )
  } catch (error: unknown) {
    console.error('RPC proxy error:', error)
    return NextResponse.json(
      {
        error: `RPC request failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      },
      { status: 500 }
    )
  }
}

// Handle OPTIONS requests for CORS
export async function OPTIONS(
  _request: NextRequest,
  { params: _params }: { params: Promise<{ chainId: string }> }
) {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  })
}
