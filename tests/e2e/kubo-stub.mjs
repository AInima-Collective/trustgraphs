#!/usr/bin/env node

import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

const port = Number(process.env.PORT || 15001)
const expectedCid = process.env.EXPECTED_CID

const stored = new Map()

function base32(bytes) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31]
  return output
}

function rawCid(bytes) {
  const digest = createHash('sha256').update(bytes).digest()
  return `b${base32(Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]))}`
}

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200).end('ok')
    return
  }
  if (request.method === 'GET' && request.url?.startsWith('/ipfs/')) {
    const cid = request.url.slice('/ipfs/'.length)
    const bytes = stored.get(cid)
    if (!bytes) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': bytes.length,
    })
    response.end(bytes)
    return
  }
  if (request.method === 'POST' && request.url?.startsWith('/api/v0/add?')) {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      const contentType = request.headers['content-type'] || ''
      const boundary = /boundary=([^;]+)/.exec(contentType)?.[1]
      if (!boundary) {
        response.writeHead(400).end('missing multipart boundary')
        return
      }
      const start = body.indexOf(Buffer.from('\r\n\r\n'))
      const end = body.lastIndexOf(Buffer.from(`\r\n--${boundary}--`))
      if (start < 0 || end <= start) {
        response.writeHead(400).end('invalid multipart body')
        return
      }
      const bytes = body.subarray(start + 4, end)
      const cid = expectedCid || rawCid(bytes)
      stored.set(cid, bytes)
      const json = Buffer.from(JSON.stringify({ Hash: cid }))
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': json.length,
      })
      response.end(json)
    })
    return
  }
  response.writeHead(404).end()
})

server.listen(port, '127.0.0.1')
