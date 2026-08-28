import { queryOptions } from '@tanstack/react-query'
import { readContract } from '@wagmi/core'

import { easAbi } from '@/lib/contract-abis'
import { easAddress } from '@/lib/config'
import { SchemaManager } from '@/lib/schemas'
import { makeWagmiConfig } from '@/lib/wagmi'

// Query keys for consistent caching
export const attestationKeys = {
  all: ['attestations'] as const,
  get: (uid: `0x${string}`) =>
    [...attestationKeys.all, 'attestation', uid] as const,
  attestation: (uid: string) =>
    [...attestationKeys.all, 'attestation', uid] as const,
}

export const attestationQueries = {
  get: (uid: `0x${string}`) =>
    queryOptions({
      queryKey: attestationKeys.get(uid),
      queryFn: async () => {
        const attestation = await readContract(makeWagmiConfig(), {
          address: easAddress,
          abi: easAbi,
          functionName: 'getAttestation',
          args: [uid],
        })

        let decodedData
        try {
          decodedData = SchemaManager.decode(
            attestation.schema,
            attestation.data
          )
        } catch (error) {
          console.error('Error decoding attestation data', attestation, error)
          decodedData = {}
        }

        return {
          ...attestation,
          decodedData,
        }
      },
      staleTime: 2 * 60 * 1000, // Individual attestations are relatively static once created
      gcTime: 10 * 60 * 1000, // Cache longer since they don't change often
    }),
}
