import { randomUUID } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'

import type { SignedAnchorBundle } from '@trustgraphs/eas-offchain-client'

import { RelayError, relayErrorBody } from './errors.ts'
import { RelaySubmissionService } from './service.ts'

const json = (
  response: ServerResponse,
  status: number,
  body: unknown
): void => {
  const encoded = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(encoded),
    'cache-control': 'no-store',
  })
  response.end(encoded)
}

const readJson = async (
  request: IncomingMessage,
  maximum: number
): Promise<unknown> => {
  const declared = Number(request.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > maximum)
    throw new RelayError(
      'BODY_LIMIT',
      'request body exceeds relay limit',
      413,
      false,
      'none'
    )
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > maximum)
      throw new RelayError(
        'BODY_LIMIT',
        'request body exceeds relay limit',
        413,
        false,
        'none'
      )
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RelayError(
      'INVALID_JSON',
      'request body must be valid JSON',
      400,
      false,
      'none'
    )
  }
}

const safeLog = (value: {
  requestId: string
  method: string
  path: string
  status: number
  code?: string
  nodeId?: string
}) => process.stdout.write(`${JSON.stringify(value)}\n`)

export const createRelayServer = (args: {
  service: RelaySubmissionService
  maxBodyBytes: number
  allowedOrigins: ReadonlySet<string>
}) =>
  createServer(async (request, response) => {
    const requestId =
      request.headers['x-request-id']?.toString().slice(0, 128) || randomUUID()
    const method = request.method ?? 'GET'
    const url = new URL(request.url ?? '/', 'http://relay.invalid')
    const origin = request.headers.origin?.toLowerCase()
    if (
      origin &&
      args.allowedOrigins.size > 0 &&
      !args.allowedOrigins.has(origin)
    ) {
      const error = new RelayError(
        'ORIGIN_NOT_ALLOWED',
        'origin is not allowlisted',
        403,
        false,
        'none'
      )
      const output = relayErrorBody(error, requestId)
      json(response, output.status, output.body)
      safeLog({
        requestId,
        method,
        path: url.pathname,
        status: output.status,
        code: error.code,
      })
      return
    }
    if (origin) {
      response.setHeader('access-control-allow-origin', origin)
      response.setHeader('vary', 'origin')
    }
    response.setHeader('x-request-id', requestId)

    if (method === 'OPTIONS' && url.pathname === '/v1/anchors') {
      response.writeHead(204, {
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type, x-request-id',
      })
      response.end()
      return
    }
    if (method === 'GET' && url.pathname === '/healthz') {
      json(response, 200, { status: 'ok' })
      return
    }
    if (method === 'GET' && url.pathname === '/metrics') {
      json(response, 200, args.service.metrics())
      return
    }
    if (method !== 'POST' || url.pathname !== '/v1/anchors') {
      json(response, 404, { error: { code: 'NOT_FOUND', requestId } })
      return
    }
    if (
      !request.headers['content-type']
        ?.toLowerCase()
        .startsWith('application/json')
    ) {
      const error = new RelayError(
        'CONTENT_TYPE',
        'content-type must be application/json',
        415,
        false,
        'none'
      )
      const output = relayErrorBody(error, requestId)
      json(response, output.status, output.body)
      return
    }
    const contentEncoding = request.headers['content-encoding']
      ?.toString()
      .trim()
      .toLowerCase()
    if (contentEncoding && contentEncoding !== 'identity') {
      const error = new RelayError(
        'CONTENT_ENCODING',
        'compressed request bodies are not accepted',
        415,
        false,
        'none'
      )
      const output = relayErrorBody(error, requestId)
      json(response, output.status, output.body)
      return
    }

    let nodeId: string | undefined
    try {
      const body = (await readJson(
        request,
        args.maxBodyBytes
      )) as SignedAnchorBundle
      const claimedNodeId = body?.message?.nodeId
      nodeId =
        typeof claimedNodeId === 'string' &&
        /^0x[0-9a-fA-F]{64}$/.test(claimedNodeId)
          ? claimedNodeId.toLowerCase()
          : undefined
      const result = await args.service.submit(body)
      json(response, 200, result)
      safeLog({ requestId, method, path: url.pathname, status: 200, nodeId })
    } catch (error) {
      const output = relayErrorBody(error, requestId)
      json(response, output.status, output.body)
      safeLog({
        requestId,
        method,
        path: url.pathname,
        status: output.status,
        code:
          error instanceof RelayError
            ? error.code
            : error instanceof Error && error.name === 'EasOffchainError'
              ? 'CLIENT_VALIDATION'
              : 'RELAY_INTERNAL',
        ...(nodeId ? { nodeId } : {}),
      })
    }
  })
