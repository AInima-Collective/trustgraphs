import { useQuery } from '@tanstack/react-query'

/**
 * Resolve an atproto DID to its handle via the PLC directory (`alsoKnownAs[0]`, sans `at://`).
 * Display-only convenience — the DID itself stays the canonical label. Cached forever (handle
 * changes are rare and the page is read-only); resolves to null on any failure.
 */
export const useDidHandle = (did?: string | null) =>
  useQuery({
    queryKey: ['plcHandle', did],
    enabled: !!did && did.startsWith('did:plc:'),
    staleTime: Infinity,
    retry: false,
    queryFn: async (): Promise<string | null> => {
      const response = await fetch(`https://plc.directory/${did}`)
      if (!response.ok) return null
      const doc = (await response.json()) as { alsoKnownAs?: string[] }
      return doc.alsoKnownAs?.[0]?.replace(/^at:\/\//, '') ?? null
    },
  })
