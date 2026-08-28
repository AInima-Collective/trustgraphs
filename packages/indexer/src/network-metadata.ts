export type NetworkMetadata = {
  name: string
  description: string
  criteria: string
  image: string
  applicationUrl: string
}

const NETWORK_METADATA_LIMITS: Record<keyof NetworkMetadata, number> = {
  name: 64,
  description: 2_000,
  criteria: 8_000,
  image: 512,
  applicationUrl: 512,
}
const NETWORK_METADATA_FIELDS = Object.keys(NETWORK_METADATA_LIMITS) as Array<
  keyof NetworkMetadata
>
const encodedLength = (value: string) => new TextEncoder().encode(value).length
const safePresentationUrl = (value: string) =>
  value.startsWith('https://') ||
  value.startsWith('http://') ||
  value.startsWith('ipfs://')

/** Apply the same bounded five-field profile shape enforced by the frontend pin endpoint. */
export const validateNetworkMetadata = (
  value: unknown
): NetworkMetadata | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== NETWORK_METADATA_FIELDS.length ||
    Object.keys(record).some(
      (key) => !NETWORK_METADATA_FIELDS.includes(key as keyof NetworkMetadata)
    )
  ) {
    return null
  }
  for (const field of NETWORK_METADATA_FIELDS) {
    const fieldValue = record[field]
    if (
      typeof fieldValue !== 'string' ||
      encodedLength(fieldValue) > NETWORK_METADATA_LIMITS[field]
    ) {
      return null
    }
  }
  const metadata = record as NetworkMetadata
  if (!metadata.name.trim()) return null
  if (metadata.image && !safePresentationUrl(metadata.image)) return null
  if (
    metadata.applicationUrl &&
    !safePresentationUrl(metadata.applicationUrl)
  ) {
    return null
  }
  return metadata
}
