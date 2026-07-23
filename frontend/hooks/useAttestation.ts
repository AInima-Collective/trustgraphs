'use client'

import { usePonderQuery } from '@ponder/react'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import { Hex, isAddressEqual } from 'viem'
import { useAccount, usePublicClient } from 'wagmi'

import { intoAttestationData, intoAttestationsData } from '@/lib/attestation'
import { easAbi } from '@/lib/contract-abis'
import { easAddress } from '@/lib/contracts'
import { parseErrorMessage, shouldRetryTxError } from '@/lib/error'
import { SchemaManager } from '@/lib/schemas'
import { txToast } from '@/lib/tx'
import { attestationKeys } from '@/queries/attestation'
import { ponderQueryFns } from '@/queries/ponder'

interface NewAttestationData {
  schema: Hex
  recipient: string
  // Array values cover the contribution claim schema's `address[]`/`uint32[]` fields.
  data: Record<string, string | boolean | string[] | number[]>
}

/**
 * Hook to manage attestation creation and revocation. If a UID is provided, the hook will also fetch attestation data for that UID.
 */
export function useAttestation(uid?: Hex) {
  const { address: connectedAddress, isConnected } = useAccount()
  const publicClient = usePublicClient()
  const queryClient = useQueryClient()

  const [isCreating, setIsCreating] = useState(false)
  const [isRevoking, setIsRevoking] = useState(false)
  const [isCreated, setIsCreated] = useState(false)
  const [isRevoked, setIsRevoked] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hash, setHash] = useState<`0x${string}` | null>(null)

  const createAttestation = async (attestationData: NewAttestationData) => {
    if (!isConnected || !connectedAddress) {
      throw new Error('Please connect your wallet')
    }

    setIsCreating(true)
    setIsCreated(false)
    setError(null)
    setHash(null)

    try {
      // Validate input formats
      if (
        !attestationData.schema.startsWith('0x') ||
        attestationData.schema.length !== 66
      ) {
        throw new Error(`Invalid schema format: ${attestationData.schema}`)
      }
      if (
        !attestationData.recipient.startsWith('0x') ||
        attestationData.recipient.length !== 42
      ) {
        throw new Error(
          `Invalid recipient address format: ${attestationData.recipient}`
        )
      }

      const encodedData = SchemaManager.encode(
        attestationData.schema,
        attestationData.data
      )

      // Helper function to execute transaction with fresh nonce
      const executeTransaction = async (retryCount = 0): Promise<void> => {
        const nonce = await publicClient!.getTransactionCount({
          address: connectedAddress,
          blockTag: retryCount === 0 ? 'pending' : 'latest',
        })

        const attestationRequest = {
          schema: attestationData.schema,
          data: {
            recipient: attestationData.recipient as `0x${string}`,
            expirationTime: 0n,
            revocable: true,
            refUID:
              '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
            data: encodedData,
            value: 0n,
          },
        }

        // Estimate gas and simulate
        const gasEstimate = await publicClient!.estimateContractGas({
          address: easAddress,
          abi: easAbi,
          functionName: 'attest',
          args: [attestationRequest],
          account: connectedAddress,
        })

        await publicClient!.simulateContract({
          address: easAddress,
          abi: easAbi,
          functionName: 'attest',
          args: [attestationRequest],
          account: connectedAddress,
        })

        const gasPrice = await publicClient!.getGasPrice()

        const [receipt] = await txToast({
          tx: {
            address: easAddress,
            abi: easAbi,
            functionName: 'attest',
            args: [attestationRequest],
            gas: (gasEstimate * 120n) / 100n,
            gasPrice: gasPrice,
            nonce,
            type: 'legacy',
          },
          onTransactionSent: setHash,
          successMessage: 'Attestation created!',
        })

        console.log(`✅ Transaction confirmed: ${receipt.transactionHash}`)

        setIsCreated(true)

        // Invalidate queries to refresh the attestation data
        queryClient.invalidateQueries({ queryKey: attestationKeys.all })
      }

      // Execute transaction with retry logic
      try {
        await executeTransaction()
      } catch (error) {
        if (shouldRetryTxError(error)) {
          console.warn('Transaction failed, retrying with fresh nonce:', error)
          // Retry once with fresh nonce
          await executeTransaction(1)
        } else {
          throw error
        }
      }
    } catch (err) {
      console.error('Error creating attestation:', err)
      setError(parseErrorMessage(err))
      throw err
    } finally {
      setIsCreating(false)
    }
  }

  const clearTransactionState = useCallback(() => {
    setIsCreated(false)
    setIsRevoked(false)
    setError(null)
    setHash(null)
  }, [])

  const revokeAttestation = async (uid: Hex, schemaUid: Hex) => {
    if (!isConnected) {
      throw new Error('Please connect your wallet')
    }

    setIsRevoking(true)
    setIsRevoked(false)
    setError(null)
    setHash(null)

    try {
      // Validate input formats
      if (!uid.startsWith('0x') || uid.length !== 66) {
        throw new Error(`Invalid attestation UID format: ${uid}`)
      }
      if (!schemaUid.startsWith('0x') || schemaUid.length !== 66) {
        throw new Error(`Invalid schema UID format: ${schemaUid}`)
      }

      // Helper function to execute transaction with fresh nonce
      const executeTransaction = async (retryCount = 0): Promise<void> => {
        const nonce = await publicClient!.getTransactionCount({
          address: connectedAddress!,
          blockTag: retryCount === 0 ? 'pending' : 'latest',
        })

        const revocationRequest = {
          schema: schemaUid,
          data: {
            uid: uid,
            value: 0n,
          },
        }

        // Estimate gas and simulate
        const gasEstimate = await publicClient!.estimateContractGas({
          address: easAddress,
          abi: easAbi,
          functionName: 'revoke',
          args: [revocationRequest],
          account: connectedAddress,
        })

        await publicClient!.simulateContract({
          address: easAddress,
          abi: easAbi,
          functionName: 'revoke',
          args: [revocationRequest],
          account: connectedAddress,
        })

        const gasPrice = await publicClient!.getGasPrice()

        const [receipt] = await txToast({
          tx: {
            address: easAddress,
            abi: easAbi,
            functionName: 'revoke',
            args: [revocationRequest],
            gas: (gasEstimate * 120n) / 100n,
            gasPrice: gasPrice,
            nonce,
            type: 'legacy',
          },
          onTransactionSent: setHash,
          successMessage: 'Attestation revoked!',
        })

        console.log(`✅ Transaction confirmed: ${receipt.transactionHash}`)

        setIsRevoked(true)

        // Invalidate queries to refresh the attestation data
        queryClient.invalidateQueries({ queryKey: attestationKeys.all })
      }

      // Execute transaction with retry logic
      try {
        await executeTransaction()
      } catch (error) {
        if (shouldRetryTxError(error)) {
          console.warn('Transaction failed, retrying with fresh nonce:', error)
          // Retry once with fresh nonce
          await executeTransaction(1)
        } else {
          throw error
        }
      }
    } catch (err) {
      console.error('Error revoking attestation:', err)
      setError(parseErrorMessage(err))
      throw err
    } finally {
      setIsRevoking(false)
    }
  }

  const query = usePonderQuery({
    queryFn: ponderQueryFns.getAttestation(uid || '0x'),
    select: useIntoAttestationData(),
    enabled: !!uid,
  })

  // Check if current user is the attester and attestation is not already revoked
  const canRevoke =
    !!connectedAddress &&
    !!query.data &&
    isAddressEqual(connectedAddress, query.data.attester) &&
    query.data.revocationTime === 0n

  return {
    createAttestation,
    revokeAttestation,
    clearTransactionState,
    isCreating,
    isRevoking,
    isLoading: isCreating || isRevoking,
    isCreated,
    isRevoked,
    isSuccess: isCreated || isRevoked,
    error,
    hash,
    isConnected,
    userAddress: connectedAddress,
    query,
    canRevoke,
  }
}

export const useIntoAttestationData = () => useCallback(intoAttestationData, [])
export const useIntoAttestationsData = () =>
  useCallback(intoAttestationsData, [])
