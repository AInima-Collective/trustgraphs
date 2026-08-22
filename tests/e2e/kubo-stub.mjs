#!/usr/bin/env node

import { createServer } from 'node:http'

const port = Number(process.env.PORT || 15001)
const expectedCid = process.env.EXPECTED_CID
if (!expectedCid) throw new Error('EXPECTED_CID is required')

let stored = null
const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200).end('ok')
    return
  }
  if (request.method === 'GET' && request.url === `/ipfs/${expectedCid}`) {
    if (!stored) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': stored.length,
    })
    response.end(stored)
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
      stored = body.subarray(start + 4, end)
      const json = Buffer.from(JSON.stringify({ Hash: expectedCid }))
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
