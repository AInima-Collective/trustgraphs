import { NetworkMetadata } from './model'

/**
 * Save a network's description to IPFS through this app's pin route, and get back the address the
 * created network will point at. The route validates and re-serializes the blob, so what lands on
 * IPFS is exactly the five presentation fields and nothing else.
 */
export const pinMetadata = async (
  metadata: NetworkMetadata
): Promise<{ cid: string; uri: string }> => {
  const response = await fetch('/api/ipfs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata),
  })

  const body = await response.json().catch(() => null)

  if (!response.ok) {
    throw new Error(
      body?.error || `Could not save the description (${response.status}).`
    )
  }
  if (!body?.cid || !body?.uri) {
    throw new Error('Could not save the description: no content id came back.')
  }

  return { cid: body.cid as string, uri: body.uri as string }
}
