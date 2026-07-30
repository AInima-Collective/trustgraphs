import { revalidatePath } from 'next/cache'
import { NextRequest, NextResponse } from 'next/server'

import { getNetwork } from '@/lib/catalog.server'

export async function GET(
  _: NextRequest,
  { params }: { params: Promise<{ networkId: string }> }
) {
  try {
    const { networkId } = await params

    if (!networkId) {
      return NextResponse.json(
        { error: 'Network ID is required' },
        { status: 400 }
      )
    }

    revalidatePath('/')

    if (networkId.toLowerCase() === 'all') {
      revalidatePath('/networks/[id]', 'page')
    } else {
      // Resolved against the runtime catalog, so a freshly created instance can be revalidated
      // without waiting for a redeploy.
      const { network, catalogError } = await getNetwork(networkId)
      if (!network) {
        return catalogError
          ? NextResponse.json(
              { error: 'Network directory unavailable', reason: catalogError },
              { status: 503 }
            )
          : NextResponse.json({ error: 'Network not found' }, { status: 404 })
      }

      revalidatePath(`/networks/${networkId}`)
    }

    return NextResponse.json({ message: 'Revalidated' })
  } catch (err) {
    console.error('Error revalidating', err)
    // If there was an error, Next.js will continue to show the last
    // successfully generated page.
    return NextResponse.json({ error: 'Error revalidating' }, { status: 500 })
  }
}
