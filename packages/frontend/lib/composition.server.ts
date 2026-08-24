import { cache } from 'react'

import type { CompositionInstance } from './composition/api'
import { APIS } from './config'

const INSTANCE_ID = /^0x[0-9a-fA-F]{64}$/

export type CompositionLookup = {
  instance: CompositionInstance | null
  error: string | null
}

/** Resolve one composition without downloading the complete composition catalog. */
export const getCompositionInstance = cache(
  async (id: string): Promise<CompositionLookup> => {
    if (!INSTANCE_ID.test(id)) return { instance: null, error: null }

    try {
      const response = await fetch(`${APIS.ponder}/compositions/${id}`, {
        cache: 'no-store',
      })
      if (response.status === 404 || response.status === 400) {
        return { instance: null, error: null }
      }
      if (!response.ok) {
        return {
          instance: null,
          error: `GET /compositions/:id responded ${response.status}`,
        }
      }
      const body = (await response.json()) as {
        instance?: CompositionInstance
      }
      return body.instance
        ? { instance: body.instance, error: null }
        : { instance: null, error: 'Composition response is malformed.' }
    } catch (error) {
      return {
        instance: null,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
)
