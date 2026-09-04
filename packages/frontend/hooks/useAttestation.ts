'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import toast from 'react-hot-toast'
import { Hex, WaitForTransactionReceiptReturnType, isAddressEqual } from 'viem'
import {
  useAccount,
  useChainId,
  usePublicClient,
  useSignTypedData,
} from 'wagmi'

import { intoAttestationData, intoAttestationsData } from '@/lib/attestation'
import { easAbi } from '@/lib/contract-abis'
import { easAddress } from '@/lib/config'
import {
  EAS_DELEGATION_TTL_SECONDS,
  EAS_DELEGATION_VERSION,
  type EasRelayAttestationData,
  type EasRelayAttestationGroup,
  MAX_RELAY_ATTESTATIONS,
  easDelegatedAttestMessage,
  easDelegatedAttestTypes,
  easDelegationDomain,
  splitEasRelaySignature,
} from '@/lib/eas-delegation'
import { parseErrorMessage } from '@/lib/error'
import { SchemaManager } from '@/lib/schemas'
import { txToast } from '@/lib/tx'
import { easAttestAndImportRouterAbi } from '@/lib/imported-eas'
import type { Network } from '@/lib/types'
import { usePonderQuery } from '@/lib/use-ponder-query'
import { attestationKeys } from '@/queries/attestation'
import { ponderQueryFns } from '@/queries/ponder'

export interface NewAttestationData {
  schema: Hex
  recipient: string
  // Array values cover the contribution claim schema's `address[]`/`uint32[]` fields.
  data: Record<string, string | boolean | string[] | number[]>
}

const EMPTY_UID =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex
const EAS_RELAY_ENABLED = process.env.NEXT_PUBLIC_EAS_RELAY_ENABLED === 'true'

const intoAttestationRequestData = (attestationData: NewAttestationData) => {
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
  return {
    recipient: attestationData.recipient as Hex,
    expirationTime: 0n,
    revocable: true,
    refUID: EMPTY_UID,
    data: SchemaManager.encode(attestationData.schema, attestationData.data),
    value: 0n,
  }
}

/**
 * Hook to manage attestation creation and revocation. If a UID is provided, the hook will also fetch attestation data for that UID.
 */
export function useAttestation(
  uid?: Hex,
  importedLane?: Network['importedLane']
) {
  const { address: connectedAddress, isConnected } = useAccount()
  const publicClient = usePublicClient()
  const chainId = useChainId()
  const { signTypedDataAsync } = useSignTypedData()
  const queryClient = useQueryClient()

  const [isCreating, setIsCreating] = useState(false)
  const [isRevoking, setIsRevoking] = useState(false)
  const [isCreated, setIsCreated] = useState(false)
  const [isRevoked, setIsRevoked] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hash, setHash] = useState<`0x${string}` | null>(null)

  const relayAttestations = async (
    attestationsData: NewAttestationData[]
  ): Promise<WaitForTransactionReceiptReturnType> => {
    if (!publicClient || !connectedAddress) {
      throw new Error('Wallet client is not ready')
    }
    if (attestationsData.length > MAX_RELAY_ATTESTATIONS) {
      throw new Error(
        `The gasless relay supports at most ${MAX_RELAY_ATTESTATIONS} attestations per batch`
      )
    }

    const version = await publicClient.readContract({
      address: easAddress,
      abi: easAbi,
      functionName: 'version',
    })
    if (version !== EAS_DELEGATION_VERSION) {
      throw new Error(`Unsupported EAS delegation version ${version}`)
    }

    const bySchema = new Map<Hex, EasRelayAttestationData[]>()
    for (const attestation of attestationsData) {
      const request = intoAttestationRequestData(attestation)
      const rows = bySchema.get(attestation.schema) ?? []
      rows.push({
        recipient: request.recipient,
        expirationTime: request.expirationTime.toString(),
        revocable: request.revocable,
        refUID: request.refUID,
        data: request.data,
        value: request.value.toString(),
      })
      bySchema.set(attestation.schema, rows)
    }

    let nonce = await publicClient.readContract({
      address: easAddress,
      abi: easAbi,
      functionName: 'getNonce',
      args: [connectedAddress],
    })
    const deadline =
      BigInt(Math.floor(Date.now() / 1000)) + EAS_DELEGATION_TTL_SECONDS
    const requests: EasRelayAttestationGroup[] = []

    // Sign in the exact schema-grouped order EAS will execute, so nonces are contiguous even when
    // the original batch alternated schemas.
    for (const [schema, data] of bySchema) {
      const signatures = []
      const nonces = []
      for (const row of data) {
        const rowNonce = nonce
        const signature = await signTypedDataAsync({
          domain: easDelegationDomain(chainId, easAddress, version),
          types: easDelegatedAttestTypes,
          primaryType: 'Attest',
          message: easDelegatedAttestMessage({
            attester: connectedAddress,
            schema,
            data: row,
            nonce: rowNonce,
            deadline,
          }),
        })
        signatures.push(splitEasRelaySignature(signature))
        nonces.push(rowNonce.toString())
        nonce += 1n
      }
      requests.push({
        schema,
        data,
        signatures,
        nonces,
        attester: connectedAddress,
        deadline: deadline.toString(),
      })
    }

    const relay = async () => {
      const response = await fetch('/api/eas-relay', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'attest',
          chainId,
          eas: easAddress,
          requests,
        }),
      })
      const body = (await response.json()) as { hash?: Hex; error?: string }
      if (!response.ok || !body.hash) {
        throw new Error(body.error || 'The EAS relay rejected the request')
      }
      setHash(body.hash)
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: body.hash,
      })
      if (receipt.status !== 'success') {
        throw new Error('The relayed EAS transaction reverted')
      }
      return receipt
    }

    return toast.promise(relay(), {
      loading: 'Agent is relaying your signed attestation…',
      success: 'Attestation relayed. It counts toward the next score update.',
      error: (relayError) => parseErrorMessage(relayError),
    })
  }

  const routeAttestations = async (
    attestationsData: NewAttestationData[]
  ): Promise<WaitForTransactionReceiptReturnType> => {
    if (!publicClient || !connectedAddress || !importedLane) {
      throw new Error('Imported EAS lane is not ready')
    }
    if (
      attestationsData.some(
        ({ schema }) =>
          schema.toLowerCase() !== importedLane.schemaUid.toLowerCase()
      )
    ) {
      throw new Error(
        'This imported network accepts only its immutable EAS schema'
      )
    }
    const version = await publicClient.readContract({
      address: importedLane.eas,
      abi: easAbi,
      functionName: 'version',
    })
    if (version !== EAS_DELEGATION_VERSION) {
      throw new Error(`Unsupported EAS delegation version ${version}`)
    }
    let nonce = await publicClient.readContract({
      address: importedLane.eas,
      abi: easAbi,
      functionName: 'getNonce',
      args: [connectedAddress],
    })
    const deadline =
      BigInt(Math.floor(Date.now() / 1000)) + EAS_DELEGATION_TTL_SECONDS
    const requests = []
    for (const attestationData of attestationsData) {
      const data = intoAttestationRequestData(attestationData)
      const signature = splitEasRelaySignature(
        await signTypedDataAsync({
          domain: easDelegationDomain(chainId, importedLane.eas, version),
          types: easDelegatedAttestTypes,
          primaryType: 'Attest',
          message: easDelegatedAttestMessage({
            attester: connectedAddress,
            schema: attestationData.schema,
            data: {
              ...data,
              expirationTime: data.expirationTime.toString(),
              value: data.value.toString(),
            },
            nonce,
            deadline,
          }),
        })
      )
      requests.push({
        schema: attestationData.schema,
        data,
        signature,
        attester: connectedAddress,
        deadline,
      })
      nonce += 1n
    }
    const grouped = [
      {
        schema: importedLane.schemaUid,
        data: requests.map((request) => request.data),
        signatures: requests.map((request) => request.signature),
        attester: connectedAddress,
        deadline,
      },
    ]
    const transaction =
      requests.length === 1
        ? {
            address: importedLane.router,
            abi: easAttestAndImportRouterAbi,
            functionName: 'attestAndImport' as const,
            args: [requests[0]!] as const,
            account: connectedAddress,
          }
        : {
            address: importedLane.router,
            abi: easAttestAndImportRouterAbi,
            functionName: 'multiAttestAndImport' as const,
            args: [grouped] as const,
            account: connectedAddress,
          }
    const gasEstimate = await publicClient.estimateContractGas(transaction)
    await publicClient.simulateContract(transaction)
    const [receipt] = await txToast({
      tx: { ...transaction, gas: (gasEstimate * 120n) / 100n } as any,
      onTransactionSent: setHash,
      successMessage:
        requests.length === 1
          ? 'Attestation saved and imported atomically.'
          : `${requests.length} attestations saved and imported atomically.`,
    })
    return receipt
  }

  const createAttestation = async (attestationData: NewAttestationData) => {
    if (!isConnected || !connectedAddress) {
      throw new Error('Please connect your wallet')
    }

    setIsCreating(true)
    setIsCreated(false)
    setError(null)
    setHash(null)

    try {
      if (importedLane) {
        const receipt = await routeAttestations([attestationData])
        setIsCreated(true)
        queryClient.invalidateQueries({ queryKey: attestationKeys.all })
        return receipt
      }
      if (EAS_RELAY_ENABLED) {
        const receipt = await relayAttestations([attestationData])
        setIsCreated(true)
        queryClient.invalidateQueries({ queryKey: attestationKeys.all })
        return receipt
      }

      const requestData = intoAttestationRequestData(attestationData)
      const attestationRequest = {
        schema: attestationData.schema,
        data: requestData,
      }
      const transaction = {
        address: easAddress,
        abi: easAbi,
        functionName: 'attest' as const,
        args: [attestationRequest] as const,
        account: connectedAddress,
      }

      // Validate the call and retain a safety margin on the gas limit. Nonce and fee fields are
      // intentionally omitted: the connected wallet owns its pending queue and must assign them.
      const gasEstimate = await publicClient!.estimateContractGas(transaction)
      await publicClient!.simulateContract(transaction)

      const [receipt] = await txToast({
        tx: {
          ...transaction,
          gas: (gasEstimate * 120n) / 100n,
        },
        onTransactionSent: setHash,
        // Saved-not-yet-counted, in one line: the attestation is durable now, the score effect
        // arrives with the next verified update. Keeps a two-minute pipeline from reading as
        // "nothing happened".
        successMessage:
          'Attestation saved. It counts toward the next score update.',
      })

      console.log(`✅ Transaction confirmed: ${receipt.transactionHash}`)
      setIsCreated(true)
      queryClient.invalidateQueries({ queryKey: attestationKeys.all })
      return receipt
    } catch (err) {
      console.error('Error creating attestation:', err)
      setError(parseErrorMessage(err))
      throw err
    } finally {
      setIsCreating(false)
    }
  }

  /** Create several attestations in one EAS transaction. Nothing is marked created on revert. */
  const createAttestations = async (attestationsData: NewAttestationData[]) => {
    if (!isConnected || !connectedAddress) {
      throw new Error('Please connect your wallet')
    }
    if (attestationsData.length === 0) {
      throw new Error('Add at least one attestation')
    }

    setIsCreating(true)
    setIsCreated(false)
    setError(null)
    setHash(null)

    try {
      if (importedLane) {
        await routeAttestations(attestationsData)
        setIsCreated(true)
        queryClient.invalidateQueries({ queryKey: attestationKeys.all })
        return
      }
      if (EAS_RELAY_ENABLED) {
        await relayAttestations(attestationsData)
        setIsCreated(true)
        queryClient.invalidateQueries({ queryKey: attestationKeys.all })
        return
      }

      const bySchema = new Map<
        Hex,
        ReturnType<typeof intoAttestationRequestData>[]
      >()
      for (const attestationData of attestationsData) {
        const rows = bySchema.get(attestationData.schema) ?? []
        rows.push(intoAttestationRequestData(attestationData))
        bySchema.set(attestationData.schema, rows)
      }
      const multiRequests = Array.from(bySchema, ([schema, data]) => ({
        schema,
        data,
      }))

      const transaction = {
        address: easAddress,
        abi: easAbi,
        functionName: 'multiAttest' as const,
        args: [multiRequests] as const,
        account: connectedAddress,
      }
      const gasEstimate = await publicClient!.estimateContractGas(transaction)
      await publicClient!.simulateContract(transaction)
      const [receipt] = await txToast({
        tx: {
          ...transaction,
          gas: (gasEstimate * 120n) / 100n,
        },
        onTransactionSent: setHash,
        successMessage: `${attestationsData.length} ratings saved. They count toward the next score update.`,
      })
      console.log(`✅ Transaction confirmed: ${receipt.transactionHash}`)
      setIsCreated(true)
      queryClient.invalidateQueries({ queryKey: attestationKeys.all })
    } catch (err) {
      console.error('Error creating attestations:', err)
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

      const revocationRequest = {
        schema: schemaUid,
        data: {
          uid,
          value: 0n,
        },
      }
      const transaction = {
        address: easAddress,
        abi: easAbi,
        functionName: 'revoke' as const,
        args: [revocationRequest] as const,
        account: connectedAddress!,
      }
      const gasEstimate = await publicClient!.estimateContractGas(transaction)
      await publicClient!.simulateContract(transaction)

      const [receipt] = await txToast({
        tx: {
          ...transaction,
          gas: (gasEstimate * 120n) / 100n,
        },
        onTransactionSent: setHash,
        successMessage:
          'Attestation revoked. The change counts toward the next score update.',
      })

      console.log(`✅ Transaction confirmed: ${receipt.transactionHash}`)
      setIsRevoked(true)
      queryClient.invalidateQueries({ queryKey: attestationKeys.all })
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
    createAttestations,
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
    isRelayEnabled: EAS_RELAY_ENABLED || !!importedLane,
    userAddress: connectedAddress,
    query,
    canRevoke,
  }
}

export const useIntoAttestationData = () => useCallback(intoAttestationData, [])
export const useIntoAttestationsData = () =>
  useCallback(intoAttestationsData, [])
