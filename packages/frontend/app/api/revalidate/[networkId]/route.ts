import { revalidatePath } from 'next/cache'
import { NextRequest, NextResponse } from 'next/server'

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

    const allNetworks = networkId.toLowerCase() === 'all'
    const instanceId = /^0x[0-9a-fA-F]{64}$/.test(networkId)
    if (!allNetworks && !instanceId) {
      return NextResponse.json(
        { error: 'Network ID must be "all" or a factory instance ID' },
        { status: 400 }
      )
    }

    revalidatePath('/')
    revalidatePath('/networks')

    if (allNetworks) {
      revalidatePath('/networks/[id]', 'page')
    } else {
      // Do not read the catalog here. Factory handlers call this endpoint before their database
      // transaction commits, so existence-checking the new instance races the write and can turn a
      // valid cache bust into a 404. Revalidating a path does not require it to have rendered yet.
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
