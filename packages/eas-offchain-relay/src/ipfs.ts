import { equalBytes } from '@trustgraphs/eas-offchain-client'

import { RelayError } from './errors.ts'
import type { BlobStore } from './types.ts'

export type IpfsTargetConfig = {
  name: string
  apiUrl: string
  authHeader?: string
}

const endpoint = (base: string, path: string): URL => {
  const url = new URL(base)
  url.pathname = `${url.pathname.replace(/\/$/, '')}${path}`
  return url
}

export class IpfsBlockStore implements BlobStore {
  readonly name: string

  constructor(private readonly config: IpfsTargetConfig) {
    this.name = config.name
  }

  private headers(): HeadersInit {
    return this.config.authHeader
      ? { authorization: this.config.authHeader }
      : {}
  }

  async putAndRead(cid: string, bytes: Uint8Array): Promise<Uint8Array> {
    const putUrl = endpoint(this.config.apiUrl, '/api/v0/block/put')
    putUrl.searchParams.set('cid-codec', 'raw')
    putUrl.searchParams.set('mhtype', 'sha2-256')
    putUrl.searchParams.set('mhlen', '32')
    putUrl.searchParams.set('pin', 'true')
    const form = new FormData()
    form.append('file', new Blob([bytes]), 'payload.bin')
    const response = await fetch(putUrl, {
      method: 'POST',
      headers: this.headers(),
      body: form,
    })
    if (!response.ok)
      throw new RelayError(
        'STORAGE_WRITE',
        `${this.name} rejected block`,
        503,
        true,
        'retry'
      )
    const result = (await response.json()) as { Key?: string }
    if (result.Key !== cid)
      throw new RelayError(
        'STORAGE_CID',
        `${this.name} returned a different CID`,
        502,
        true,
        'retry'
      )

    const getUrl = endpoint(this.config.apiUrl, '/api/v0/block/get')
    getUrl.searchParams.set('arg', cid)
    const readback = await fetch(getUrl, {
      method: 'POST',
      headers: this.headers(),
    })
    if (!readback.ok)
      throw new RelayError(
        'STORAGE_READ',
        `${this.name} readback failed`,
        503,
        true,
        'retry'
      )
    return new Uint8Array(await readback.arrayBuffer())
  }
}

export const storeWithQuorum = async (
  stores: readonly BlobStore[],
  quorum: number,
  cid: string,
  bytes: Uint8Array
): Promise<string[]> => {
  const outcomes = await Promise.allSettled(
    stores.map(async (store) => {
      const readback = await store.putAndRead(cid, bytes)
      if (!equalBytes(readback, bytes))
        throw new RelayError(
          'STORAGE_BYTES',
          `${store.name} returned different bytes`,
          502,
          true,
          'retry'
        )
      return store.name
    })
  )
  const accepted = outcomes
    .filter(
      (outcome): outcome is PromiseFulfilledResult<string> =>
        outcome.status === 'fulfilled'
    )
    .map((outcome) => outcome.value)
  if (accepted.length < quorum)
    throw new RelayError(
      'STORAGE_QUORUM',
      'byte-exact storage quorum was not reached',
      503,
      true,
      'retry',
      {
        accepted: accepted.length,
        required: quorum,
      }
    )
  return accepted
}
