import { EasOffchainError } from '@trustgraphs/eas-offchain-client'

export class RelayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly action: 'none' | 'retry' | 'reload',
    readonly details?: Readonly<Record<string, unknown>>
  ) {
    super(message)
    this.name = 'RelayError'
  }
}

export const relayErrorBody = (error: unknown, requestId: string) => {
  if (error instanceof RelayError)
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          action: error.action,
          requestId,
          ...(error.details ? { details: error.details } : {}),
        },
      },
    }
  if (error instanceof EasOffchainError)
    return {
      status: 422,
      body: {
        error: {
          code: error.code,
          message: error.message,
          retryable: false,
          action: 'none' as const,
          requestId,
        },
      },
    }
  return {
    status: 500,
    body: {
      error: {
        code: 'RELAY_INTERNAL',
        message: 'relay failed without exposing internal or secret material',
        retryable: true,
        action: 'retry' as const,
        requestId,
      },
    },
  }
}
