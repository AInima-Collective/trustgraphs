#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

const port = Number(process.env.PORT || 15101)
const failWrites = process.env.FAIL_WRITES === '1'
const corruptReads = process.env.CORRUPT_READS === '1'
const blocks = new Map()

const base32 = (bytes) => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let accumulator = 0
  let bits = 0
  let output = ''
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      output += alphabet[(accumulator >>> bits) & 31]
    }
  }
  if (bits > 0) output += alphabet[(accumulator << (5 - bits)) & 31]
  return output
}

const rawCid = (bytes) => {
  const digest = createHash('sha256').update(bytes).digest()
  return `b${base32(Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]))}`
}

const multipartFile = (request, body) => {
  const contentType = request.headers['content-type'] || ''
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1]
  if (!boundary) throw new Error('missing multipart boundary')
  const start = body.indexOf(Buffer.from('\r\n\r\n'))
  const end = body.lastIndexOf(Buffer.from(`\r\n--${boundary}--`))
  if (start < 0 || end <= start) throw new Error('invalid multipart body')
  return body.subarray(start + 4, end)
}

const sendBlock = (response, block) => {
  const body = corruptReads
    ? Buffer.concat([Buffer.from([block[0] ^ 1]), block.subarray(1)])
    : block
  response.writeHead(200, {
    'content-type': 'application/vnd.ipld.raw',
    'content-length': body.length,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  })
  response.end(body)
}

const server = createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://kubo.invalid')
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-max-age': '600',
    })
    response.end()
    return
  }
  if (request.method === 'GET' && url.pathname === '/health') {
    response.writeHead(200).end('ok')
    return
  }
  if (request.method === 'GET' && url.pathname === '/debug/blocks') {
    const body = Buffer.from(JSON.stringify([...blocks.keys()].sort()))
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': body.length,
    })
    response.end(body)
    return
  }
  if (request.method === 'GET' && url.pathname.startsWith('/ipfs/')) {
    const cid = url.pathname.slice('/ipfs/'.length)
    const block = blocks.get(cid)
    if (!block) {
      response.writeHead(404).end()
      return
    }
    sendBlock(response, block)
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/v0/block/get') {
    const block = blocks.get(url.searchParams.get('arg'))
    if (!block) {
      response.writeHead(404).end()
      return
    }
    sendBlock(response, block)
    return
  }
  if (
    request.method === 'POST' &&
    (url.pathname === '/api/v0/block/put' || url.pathname === '/api/v0/add')
  ) {
    if (failWrites) {
      response.writeHead(503).end('injected write failure')
      return
    }
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      try {
        const block = multipartFile(request, Buffer.concat(chunks))
        const cid = rawCid(block)
        blocks.set(cid, Buffer.from(block))
        const result =
          url.pathname === '/api/v0/add'
            ? { Name: 'trustgraph-network.json', Hash: cid, Size: block.length }
            : { Key: cid, Size: block.length }
        const body = Buffer.from(JSON.stringify(result))
        response.writeHead(200, {
          'content-type': 'application/json',
          'content-length': body.length,
        })
        response.end(body)
      } catch (error) {
        response
          .writeHead(400)
          .end(error instanceof Error ? error.message : 'bad request')
      }
    })
    return
  }
  response.writeHead(404).end()
})

server.listen(port, '127.0.0.1')
