export type EasOffchainErrorCode =
  | 'E0_MAGIC'
  | 'E0_PAYLOAD_VERSION'
  | 'E0_TRUNCATED'
  | 'E0_TRAILING_BYTES'
  | 'E0_PAYLOAD_LIMIT'
  | 'E0_ENTRY_LIMIT'
  | 'E0_DATA_LIMIT'
  | 'E0_COUNT_MISMATCH'
  | 'E0_LOG_KIND'
  | 'E0_DUPLICATE_ATTEST'
  | 'E0_REVOKE_BEFORE_ATTEST'
  | 'E0_ALREADY_REVOKED'
  | 'E0_PROFILE_VERSION'
  | 'E0_SCHEMA'
  | 'E0_RECIPIENT'
  | 'E0_FUTURE_TIME'
  | 'E0_EXPIRATION'
  | 'E0_REVOCABLE'
  | 'E0_REF_UID'
  | 'E0_ZERO_SALT'
  | 'E0_DATA_ABI'
  | 'E0_UID'
  | 'E0_SIGNATURE_FORM'
  | 'E0_EAS_SIGNATURE'
  | 'E0_COMMITMENT'
  | 'E0_NODE_ID'
  | 'E0_HEAD'
  | 'E0_PREVIOUS_HEAD'
  | 'E0_HEAD_SIGNATURE'
  | 'E0_CANONICAL'
  | 'E0_CONFLICT'
  | 'E0_DRAFT_CRYPTO'

export class EasOffchainError extends Error {
  constructor(
    readonly code: EasOffchainErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>
  ) {
    super(message)
    this.name = 'EasOffchainError'
  }
}

export const fail = (
  code: EasOffchainErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>
): never => {
  throw new EasOffchainError(code, message, details)
}
