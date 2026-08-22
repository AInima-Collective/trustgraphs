import { NextRequest, NextResponse } from 'next/server'

import { APIS } from '@/lib/config'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ cid: string }> }
) {
  try {
    const { cid } = await params

    if (!cid) {
      return NextResponse.json(
        { error: 'CID parameter is required' },
        { status: 400 }
      )
    }

    // Make GET request to IPFS gateway
    const ipfsUrl = APIS.ipfsGateway + cid

    const response = await fetch(ipfsUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      console.error(
        `IPFS fetch failed: ${response.status} ${response.statusText}`
      )
      return NextResponse.json(
        { error: `Failed to fetch from IPFS: ${response.status}` },
        { status: response.status }
      )
    }

    const data = await response.json()

    return NextResponse.json(data)
  } catch (error: any) {
    console.error('IPFS proxy error:', error)
    return NextResponse.json(
      { error: `IPFS request failed: ${error.message}` },
      { status: 500 }
    )
  }
}
