import { NextRequest, NextResponse } from 'next/server'
import { mainnet } from 'viem/chains'

const MAX_RPC_BODY_BYTES = 256 * 1024
const MAX_RPC_BATCH_SIZE = 50
const DEVELOPMENT_MAINNET_RPC_URLS = [
  'https://ethereum-rpc.publicnode.com',
  'https://public.1rpc.io/eth',
] as const

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

    // Get the private RPC URL from environment variables based on chain ID
    const configuredRpcUrl =
      (!id && process.env[`RPC_URL_${chainId}`]) ||
      process.env[`RPC_URL_${chainId}_${id}`]
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

    // Parse the request body
    const body = await request.json()

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
