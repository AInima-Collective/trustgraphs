/** Convert a JSON-RPC quantity to a safe JavaScript block number. */
export function parseRpcQuantity(value, label = 'RPC quantity') {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new Error(`${label} is not a valid JSON-RPC quantity: ${value}`)
  }

  const parsed = Number(BigInt(value))
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} is outside JavaScript's safe integer range`)
  }
  return parsed
}

/** Parse an optional block-number environment variable. */
export function parseStartBlock(value, fallback, name) {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(
      `${name} must be a non-negative safe integer, got "${value}"`
    )
  }
  return parsed
}

export const toBlockTag = (blockNumber) => `0x${blockNumber.toString(16)}`

/**
 * Ponder's RPC cache is keyed by chain id. Local Anvil incarnations all use 31337, so keep an
 * independently recorded block hash to tell a process restart from a different chain.
 */
export function sameChainIdentity(stored, currentBlock) {
  return (
    stored !== undefined &&
    Number(stored.anchor_block) === currentBlock.number &&
    stored.anchor_hash.toLowerCase() === currentBlock.hash.toLowerCase()
  )
}

/** A short, Postgres-safe schema name unique to this local chain incarnation and app build. */
export function localSchemaName(chainId, anchorBlock, appFingerprint) {
  if (!/^0x[0-9a-f]{64}$/i.test(anchorBlock.hash)) {
    throw new Error(`Anchor block hash is invalid: ${anchorBlock.hash}`)
  }
  if (!/^[0-9a-f]{64}$/i.test(appFingerprint)) {
    throw new Error(`App fingerprint is invalid: ${appFingerprint}`)
  }
  return `tg_dev_${chainId}_${anchorBlock.number}_${anchorBlock.hash.slice(2, 8)}_${appFingerprint.slice(0, 8)}`
}
